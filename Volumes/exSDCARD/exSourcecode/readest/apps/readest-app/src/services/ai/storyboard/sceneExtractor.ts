/**
 * Scene Extractor v3 - Incremental Chapter Processing Version
 */

// ============================================================
// Types
// ============================================================

export interface SceneExtractorOptions {
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  maxScenes?: number;
  /** Max chars per text chunk for incremental processing (default: 500) */
  maxChunkChars?: number;
  /** Timeout in ms for Ollama API calls (default: 120000) */
  timeoutMs?: number;
}

interface RawBookData {
  content: string;
  title?: string;
  author?: string;
}

export interface ContinuityContext {
  summary: string;
  keyCharacters: Record<string, CharacterAppearance>;
  lastFrame: FrameDescription;
}

export interface CharacterAppearance {
  name: string;
  description: string;
}

export interface FrameDescription {
  description: string;
  index: number;
}

interface IncrementalFrame {
  description: string;
  index: number;
}

/** Raw scene object returned from Ollama after validation */
export interface RawScene {
  scene_title: string;
  frame1_description: string;
  frame2_description: string;
  frame3_description: string;
  frame4_description: string;
  character_appearance?: string;
  costume_outfit?: string;
  action_plot?: string;
  dialogues?: { text: string }[];
  audio_mood?: string;
}

/** CharacterAppearance used in ContinuityContext (also re-exported from types.ts) */
export interface CharacterAppearanceData {
  name: string;
  description: string;
}

/** FrameDescription for continuity tracking */
export interface FrameDescData {
  description: string;
  index: number;
}

// ============================================================
// Ollama API helpers (direct fetch, no ai package / zod)
// ============================================================

async function ollamaGenerate(
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 120_000));

  console.log('[Ollama API] >>> Request details:', {
    url: `${baseUrl}/api/generate`,
    model,
    systemPromptLength: systemPrompt.length,
    userPromptLength: userPrompt.length,
    userPromptPreview: userPrompt.slice(0, 150),
  });

  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: userPrompt,
        system: systemPrompt,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    console.log('[Ollama API] >>> Response status:', response.status, response.statusText);
    console.log(
      '[Ollama API] >>> Response headers:',
      Object.fromEntries(response.headers.entries()),
    );

    const text = await response.text();
    console.log('[Ollama API] >>> Raw response body (first 1000 chars):', text.slice(0, 1000));

    if (!response.ok) {
      throw new Error(
        `Ollama API error: ${response.status} ${response.statusText}. Body: ${text.slice(0, 500)}`,
      );
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      console.error('[Ollama API] >>> Failed to parse response as JSON:', text.slice(0, 500));
      throw new Error(`Failed to parse Ollama response as JSON: ${String(parseError)}`);
    }

    const rawResponse = String(data.response ?? '').trim();
    console.log('[Ollama API] >>> Parsed "response" field length:', rawResponse.length);
    console.log('[Ollama API] >>> Response preview (first 500 chars):', rawResponse.slice(0, 500));

    return rawResponse;
  } catch (error: any) {
    clearTimeout(timer);
    if ((error as any).name === 'AbortError') {
      throw new Error(`Ollama API request timed out after ${timeoutMs}ms`);
    }
    console.error('[Ollama API] >>> Error:', error?.message || error);
    throw error;
  }
}

// ============================================================
// JSON extraction utility (no zod dependency)
// ============================================================

function extractJSON(text: string): any | null {
  const trimmed = text.trim();
  console.log('[extractJSON] Input text length:', trimmed.length);

  let body = trimmed;

  // Strategy 1: Find the first "{" and last "}" to form a candidate JSON
  const jsonStart = body.indexOf('{');
  if (jsonStart === -1) {
    console.log('[extractJSON] No opening brace found, returning null');
    return null;
  }

  // Also try to find "]" for arrays of objects like [{"scene_title": ...}]
  let lastBrace = body.lastIndexOf('}');
  let lastBracket = body.lastIndexOf(']');

  const jsonEnd = Math.max(lastBrace, lastBracket);
  if (jsonEnd === -1) {
    console.log('[extractJSON] No closing brace/bracket found, returning null');
    return null;
  }

  // Extract from first { to last } or ]
  body = body.slice(jsonStart, jsonEnd + 1);
  console.log('[extractJSON] Extracted JSON candidate length:', body.length);

  // Strip code fence markers
  if (body.startsWith('```')) {
    body = body.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    console.log('[extractJSON] Stripped code fence markers');
  }

  // Try multiple strategies to fix the JSON
  const fixedBody = body
    .replace(/(\u201c|&\#x201c;|&#34;)([^"\\]*(?:\\.[^"\\]*)*)(\u201d|&\#x201d;|&#34;)/g, '"$2"')
    .replace(/\u201c/g, '"')
    .replace(/\u201d/g, '"');

  // Try parsing the full candidate first
  try {
    const result = JSON.parse(fixedBody);
    console.log('[extractJSON] Full candidate parse succeeded, length:', fixedBody.length);
    return result;
  } catch (parseError: unknown) {
    const errMsg = parseError instanceof Error ? parseError.message : String(parseError);
    console.log('[extractJSON] Full parse failed:', errMsg.slice(0, 100));

    // Strategy 2: Try removing trailing incomplete keys/values after the last valid value
    // This handles cases where AI truncates mid-key or returns partial JSON
    const cleaned = cleanTruncatedJSON(fixedBody);
    if (cleaned && cleaned !== fixedBody) {
      try {
        const result = JSON.parse(cleaned);
        console.log('[extractJSON] Cleaned parse succeeded, length:', cleaned.length);
        return result;
      } catch (parseError2: unknown) {
        const errMsg2 = parseError2 instanceof Error ? parseError2.message : String(parseError2);
        console.log('[extractJSON] Cleaned parse also failed:', errMsg2.slice(0, 100));
      }
    }

    // Strategy 3: Try brace-matching with greedy approach (try from innermost to outermost)
    const depthMatch = findBestBraceMatch(fixedBody);
    if (depthMatch && depthMatch !== fixedBody) {
      try {
        const result = JSON.parse(depthMatch);
        console.log('[extractJSON] Brace-match parse succeeded, length:', depthMatch.length);
        return result;
      } catch (parseError3: unknown) {
        const errMsg3 = parseError3 instanceof Error ? parseError3.message : String(parseError3);
        console.log('[extractJSON] Brace-match parse also failed:', errMsg3.slice(0, 100));
      }
    }

    console.log('[extractJSON] All extraction strategies exhausted');
  }

  return null;
}

/**
 * Remove trailing incomplete keys/values from truncated JSON.
 * E.g., `"dialogues": [{"text": "hello"}, {` -> keep only valid parts.
 */
function cleanTruncatedJSON(text: string): string | null {
  // Find the last complete key-value pair by scanning backwards
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      if (depth === 0) break; // Found the matching outer closing brace
      depth--;
    }
  }

  return null; // Return null to indicate we couldn't clean it — try other strategies
}

/**
 * Try finding a valid JSON by progressively removing trailing characters.
 */
function findBestBraceMatch(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;

    // When depth returns to 0, we have a complete JSON object/array
    if (depth === 0 && i < text.length - 1) {
      try {
        const candidate = text.slice(0, i + 1);
        JSON.parse(candidate); // Will throw if invalid
        return candidate;
      } catch {
        // Not valid yet, continue searching
        continue;
      }
    }
  }

  return null;
}

// ============================================================
// SceneExtractor class
// ============================================================

export class SceneExtractor {
  private ollamaBaseUrl: string;
  private ollamaModel: string;
  private maxScenes: number;
  private maxChunkChars: number;
  private timeoutMs: number;

  constructor(options?: SceneExtractorOptions | { ollamaBaseUrl?: string; ollamaModel?: string }) {
    if (!options) options = {};

    // Determine if it's the new Style or legacy AISettings-like object
    const isSceneExtractorOptions =
      'maxScenes' in (options as any) && typeof (options as any).maxScenes !== 'undefined';

    if (isSceneExtractorOptions) {
      const opts = options as SceneExtractorOptions;
      this.ollamaBaseUrl = opts.ollamaBaseUrl || 'http://127.0.0.1:11434';
      this.ollamaModel = opts.ollamaModel || '';
      this.maxScenes = opts.maxScenes ?? 20;
      this.maxChunkChars = opts.maxChunkChars ?? 500;
      this.timeoutMs = opts.timeoutMs ?? 180_000;
    } else {
      // Legacy AISettings-like style (from storyboardGenerator.ts)
      const settings = options as { ollamaBaseUrl?: string; ollamaModel?: string };
      this.ollamaBaseUrl = settings.ollamaBaseUrl || 'http://127.0.0.1:11434';
      this.ollamaModel = settings.ollamaModel || '';
      this.maxScenes = 20;
      this.maxChunkChars = 500;
      this.timeoutMs = 180_000;
    }

    console.log(
      '[SceneExtractor] Constructor: baseUrl=',
      this.ollamaBaseUrl,
      'model=',
      this.ollamaModel || '(default qwen3-vl-nsfw)',
    );
  }

  async extract(bookData: RawBookData): Promise<RawScene[]> {
    const { content = '' } = bookData;
    const title = (bookData.title ?? 'Untitled') as string;

    console.log('[SceneExtractor v3] Extracting scenes:', {
      title,
      author: bookData.author || 'Unknown',
      totalChars: content.length,
      maxScenes: this.maxScenes,
      chunkSize: this.maxChunkChars,
    });

    const chunks = this.chunkParagraphs(content);
    console.log(`[SceneExtractor v3] Book split into ${chunks.length} chunks`);

    const allScenes: RawScene[] = [];
    let accumulatedFrames: IncrementalFrame[] = [];
    let chunkIndex = 0;

    for (const chunk of chunks) {
      chunkIndex++;

      let newFrames: IncrementalFrame[] = [];
      try {
        newFrames = await this.extractKeyFrames(chunk, accumulatedFrames);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[SceneExtractor v3] extractKeyFrames error in chunk ${chunkIndex}:`, errMsg);
      }

      if (newFrames && newFrames.length > 0) {
        accumulatedFrames.push(...newFrames);
        console.log(
          `[SceneExtractor v3] Chunk ${chunkIndex}: got ${newFrames.length} frame(s), ` +
            `accumulated: ${accumulatedFrames.length}`,
        );

        if (accumulatedFrames.length >= 4) {
          const MAX_SCENE_RETRIES = 2;
          let sceneRetries = 0;
          let consecutiveEmptyRetries = 0;
          let synthesizedScene: RawScene | null = null;

          while (sceneRetries <= MAX_SCENE_RETRIES && consecutiveEmptyRetries < 3) {
            try {
              synthesizedScene = await this.synthesizeScene(accumulatedFrames, title, chunkIndex);

              const hasContent =
                synthesizedScene &&
                (synthesizedScene.frame1_description?.trim().length > 0 ||
                  synthesizedScene.frame2_description?.trim().length > 0 ||
                  synthesizedScene.frame3_description?.trim().length > 0 ||
                  synthesizedScene.frame4_description?.trim().length > 0);

              if (!hasContent) {
                consecutiveEmptyRetries++;
                sceneRetries++;
                console.error(
                  `[extract] Chunk ${chunkIndex}: Scene has no frame content ` +
                    `(consecutiveEmptyRetries=${consecutiveEmptyRetries}/3)`,
                );
                await new Promise((resolve) => setTimeout(resolve, 1000 * sceneRetries));
                continue;
              }

              if (synthesizedScene && Object.keys(synthesizedScene).length > 0) {
                allScenes.push(synthesizedScene);
                console.log(
                  `[extract] Chunk ${chunkIndex}: Synthesized scene ${allScenes.length}: "${synthesizedScene.scene_title}"`,
                );
              }

              accumulatedFrames = [];
              consecutiveEmptyRetries = 0; // Reset on success
              break;
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              console.error(
                `[extract] Chunk ${chunkIndex} synthesizeScene error (retry ${sceneRetries + 1}/${MAX_SCENE_RETRIES}):`,
                errMsg,
              );
              sceneRetries++;
              await new Promise((resolve) => setTimeout(resolve, 1000 * sceneRetries));
            }
          }

          // If we exhausted retries without getting a valid scene, just skip this chunk
          if (consecutiveEmptyRetries >= 3 && !synthesizedScene) {
            console.warn(
              `[extract] Chunk ${chunkIndex}: Skipped after ${consecutiveEmptyRetries} consecutive empty AI responses`,
            );
            accumulatedFrames = []; // Reset to prevent infinite accumulation on same chunk
          } else if (consecutiveEmptyRetries >= 3 && synthesizedScene) {
            // We got a scene but it had no content — skip it
            console.warn(`[extract] Chunk ${chunkIndex}: Skipped empty scene after retries`);
            accumulatedFrames = [];
          } else if (synthesizedScene === null) {
            // All try/catch errors exhausted, reset frames to prevent infinite loop on same chunk
            console.warn(
              `[extract] Chunk ${chunkIndex}: All synthesis attempts failed, resetting frames`,
            );
            accumulatedFrames = [];
          }
        }
      } else {
        console.log(
          `[SceneExtractor v3] Chunk ${chunkIndex}: no new frames, ` +
            `accumulated: ${accumulatedFrames.length}`,
        );
      }

      if (allScenes.length >= this.maxScenes) break;
    }

    // Handle remaining frames (less than 4) — try a final scene if we have at least 2
    if (accumulatedFrames.length >= 2 && allScenes.length < this.maxScenes) {
      const scene = await this.synthesizeScene(accumulatedFrames, title, chunkIndex + 1);
      if (scene && Object.keys(scene).length > 0) {
        allScenes.push(scene);
      }
    }

    console.log(
      `[SceneExtractor v3] Complete: ${allScenes.length} scenes from ${chunks.length} chunks`,
    );
    return allScenes;
  }

  // ----------------------------------------------------------
  // Internal helpers
  // ----------------------------------------------------------

  private chunkParagraphs(content: string): string[] {
    const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 20);
    if (paragraphs.length === 0) return [];

    const chunks: string[] = [];
    let current = '';

    for (const para of paragraphs) {
      if (current.length + para.length > this.maxChunkChars && current.length > 50) {
        chunks.push(current.trim());
        current = para;
      } else {
        current += '\n\n' + para;
      }
    }

    if (current.trim().length > 50) {
      chunks.push(current.trim());
    }

    return chunks;
  }

  private async extractKeyFrames(
    chunk: string,
    previousFrames: IncrementalFrame[],
  ): Promise<IncrementalFrame[]> {
    const nextIndex = this.calculateNextFrameIndex(previousFrames);

    console.log(
      '[SceneExtractor v3] >>> Extracting key frames for chunk (length:',
      chunk.length,
      ')',
    );
    console.log('[SceneExtractor v3] >>> Chunk content preview:', chunk.slice(0, 200));

    const systemPrompt = `You are a key-frame extractor for comic scene generation. 
Given a text excerpt and previously extracted frames, extract the **next 1-2 most important new visual moments** that should be captured as frames in the storyboard.

Rules:
- Each frame description must be vivid, detailed (50-80 words), and capture a distinct visual moment
- Focus on: character expressions, actions, environment changes, emotional beats
- Number frames sequentially starting from ${nextIndex}
- Return ONLY valid JSON with this structure: {"frames": [{"description": "...", "index": N}]}`;

    const userPrompt = `Text excerpt (chunk):
${this.truncateForPrompt(chunk, 400)}

Previously extracted frames (${previousFrames.length}):
${previousFrames.map((f) => `[Frame ${f.index}]: ${f.description}`).join('\n') || 'None yet'}

Please extract the next 1-2 most important new frames from this excerpt:`;

    console.log(
      '[extractKeyFrames] Calling callOllama with system prompt length:',
      systemPrompt.length,
      'user prompt length:',
      userPrompt.length,
    );

    const response = await this.callOllama(systemPrompt, userPrompt);

    console.log(
      '[SceneExtractor v3] >>> Ollama raw response (first 500 chars):',
      response.slice(0, 500),
    );
    console.log('[extractKeyFrames] callOllama returned response length:', response.length);

    const frames = this.parseFrameExtraction(response);
    console.log('[SceneExtractor v3] >>> Parsed frames count:', frames.length);

    return frames;
  }

  private calculateNextFrameIndex(previousFrames: IncrementalFrame[]): number {
    if (previousFrames.length === 0) return 1;
    const maxIndex = Math.max(...previousFrames.map((f) => f.index));
    return maxIndex + 1;
  }

  private parseFrameExtraction(response: string): IncrementalFrame[] {
    const parsed = extractJSON(response);
    if (!parsed) return [];

    if (parsed.frames && Array.isArray(parsed.frames)) {
      return parsed.frames.map((f: any, i: number) => ({
        description: typeof f.description === 'string' ? f.description : '',
        index: typeof f.index === 'number' ? f.index : i + 1,
      }));
    }

    if (response.trim().length > 30) {
      return [{ description: response.trim(), index: 1 }];
    }

    return [];
  }

  private async synthesizeScene(
    frames: IncrementalFrame[],
    bookTitle: string,
    chunkIndex: number,
  ): Promise<RawScene> {
    const systemPrompt = `You are a storyboard scene synthesizer for comics/manga. 
Given accumulated key frames from a chapter, synthesize them into ONE cohesive comic scene with detailed descriptions.

Return ONLY valid JSON matching this exact schema (no markdown fences, no prose):
{
  "scene_title": "...",
  "frame1_description": "...",
  "frame2_description": "...",
  "frame3_description": "...", 
  "frame4_description": "...",
  "character_appearance": "...",
  "costume_outfit": "...",
  "action_plot": "...",
  "dialogues": [{"text": "..."}],
  "audio_mood": "..."
}`;

    const frameDescriptions = frames.map((f) => `Frame ${f.index}: ${f.description}`).join('\n');

    const userPrompt = `Chapter: ${bookTitle} (chunk ${chunkIndex})

Accumulated key frames (${frames.length}):
${frameDescriptions}

Please synthesize these frames into ONE complete comic scene. Distribute the frame content across 4 panels, and fill in additional context where needed.`;

    const response = await this.callOllama(systemPrompt, userPrompt);
    return this.parseSceneResponse(response, bookTitle, chunkIndex);
  }

  parseSceneResponse(response: string, bookTitle: string, chunkIndex: number): RawScene {
    console.log('[parseSceneResponse] ========== START ==========');
    console.log('[parseSceneResponse] bookTitle:', bookTitle);
    console.log('[parseSceneResponse] chunkIndex:', chunkIndex);
    console.log('[parseSceneResponse] Input length:', response.length);
    console.log(
      '[parseSceneResponse] Raw response (first 800 chars):',
      JSON.stringify(response.slice(0, 800)),
    );

    const parsed = extractJSON(response);

    if (!parsed) {
      console.error(
        '[parseSceneResponse] *** JSON PARSING FAILED *** — calling gracefulRecovery now',
      );
      const recovered = this.gracefulRecovery(response, bookTitle, chunkIndex);
      return recovered;
    }

    console.log('[parseSceneResponse] JSON parsed successfully!');
    console.log('[parseSceneResponse] Parsed keys:', Object.keys(parsed));
    console.log('[parseSceneResponse] scene_title:', parsed.scene_title);
    console.log(
      '[parseSceneResponse] frame1_description length:',
      String(parsed.frame1_description || '').length,
    );
    console.log(
      '[parseSceneResponse] frame2_description length:',
      String(parsed.frame2_description || '').length,
    );
    console.log(
      '[parseSceneResponse] frame3_description length:',
      String(parsed.frame3_description || '').length,
    );
    console.log(
      '[parseSceneResponse] frame4_description length:',
      String(parsed.frame4_description || '').length,
    );

    const scene: RawScene = {
      scene_title: String(parsed.scene_title || `Scene ${chunkIndex}`),
      frame1_description: String(parsed.frame1_description || ''),
      frame2_description: String(parsed.frame2_description || ''),
      frame3_description: String(parsed.frame3_description || ''),
      frame4_description: String(parsed.frame4_description || ''),
    };

    if (typeof parsed.character_appearance === 'string' && parsed.character_appearance.trim()) {
      scene.character_appearance = parsed.character_appearance;
      console.log('[parseSceneResponse] character_appearance:', parsed.character_appearance);
    }
    if (typeof parsed.costume_outfit === 'string' && parsed.costume_outfit.trim()) {
      scene.costume_outfit = parsed.costume_outfit;
      console.log('[parseSceneResponse] costume_outfit:', parsed.costume_outfit);
    }

    // action_plot — normalize to string (dialogues handled separately below)
    if (parsed.action_plot !== undefined && parsed.action_plot !== null) {
      const plotVal: unknown = parsed.action_plot;
      console.log(
        '[parseSceneResponse] action_plot type:',
        typeof plotVal,
        Array.isArray(plotVal) ? 'array' : '',
      );
      if (typeof plotVal === 'string') {
        const trimmed = plotVal.trim();
        console.log('[parseSceneResponse] action_plot string length:', trimmed.length);
        if (trimmed.length > 0) scene.action_plot = trimmed as any;
      } else if (Array.isArray(plotVal)) {
        // If action_plot is an array, extract text from each element — these are treated as dialogues
        console.log('[parseSceneResponse] action_plot is array with', plotVal.length, 'items');
        scene.dialogues = plotVal.map((d: any) => ({ text: String(d.text ?? d) }));
      }
    }

    // Explicitly handle dialogues field if present separately
    if (
      parsed.dialogues !== undefined &&
      parsed.dialogues !== null &&
      Array.isArray(parsed.dialogues)
    ) {
      console.log('[parseSceneResponse] dialogues array with', parsed.dialogues.length, 'items');
      console.log(
        '[parseSceneResponse] dialogues first item:',
        JSON.stringify(parsed.dialogues[0]),
      );
      scene.dialogues = parsed.dialogues.map((d: any) => ({ text: String(d.text ?? '') }));
    }

    if (typeof parsed.audio_mood === 'string' && parsed.audio_mood.trim()) {
      scene.audio_mood = parsed.audio_mood;
      console.log('[parseSceneResponse] audio_mood:', parsed.audio_mood);
    }

    // Summary: check which optional fields are populated
    const filledFields = [
      scene.character_appearance,
      scene.costume_outfit,
      scene.action_plot,
      scene.dialogues,
      scene.audio_mood,
    ].filter((f) => f !== undefined && f !== null).length;
    console.log('[parseSceneResponse] Optional fields filled:', filledFields, '/ 5');

    console.log('[parseSceneResponse] ========== END (SUCCESS) ==========');
    return scene;
  }

  /**
   * Graceful recovery: when full JSON parsing fails, try to extract as much
   * structured data as possible from the raw text response.
   */
  private gracefulRecovery(response: string, bookTitle: string, chunkIndex: number): RawScene {
    console.log('[gracefulRecovery] ========== START ==========');
    console.log('[gracefulRecovery] bookTitle:', bookTitle);
    console.log('[gracefulRecovery] chunkIndex:', chunkIndex);
    console.log('[gracefulRecovery] Response length:', response.length);
    console.log(
      '[gracefulRecovery] Raw response (first 1000 chars):',
      JSON.stringify(response.slice(0, 1000)),
    );

    const recovered: RawScene = {
      scene_title: `Scene ${chunkIndex}`,
      frame1_description: '',
      frame2_description: '',
      frame3_description: '',
      frame4_description: '',
    };

    // Try to extract scene title from "scene_title": "..." patterns (even without full JSON)
    console.log('[gracefulRecovery] Trying to extract scene_title...');
    const titleMatch = response.match(
      /["']scene_title["']\s*:\s*["']([^"\\]*(?:\\.[^"\\]*)*)["']/i,
    );
    if (titleMatch && titleMatch[1]) {
      recovered.scene_title = this.cleanEscapedChars(titleMatch[1]);
      console.log('[gracefulRecovery] Found scene_title:', recovered.scene_title);
    } else {
      console.log('[gracefulRecovery] No scene_title match found');
    }

    // Try to extract frame descriptions from "frameN_description": "..." patterns
    for (let i = 1; i <= 4; i++) {
      const frameKey = `frame${i}_description`;
      console.log('[gracefulRecovery] Trying to extract', frameKey, '...');
      // Use a more permissive regex that handles escaped quotes inside values
      const frameRegex = new RegExp(`["']${frameKey}["']\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i');
      const frameMatch = response.match(frameRegex);
      if (frameMatch && frameMatch[1]) {
        recovered[frameKey as keyof RawScene] = this.cleanEscapedChars(frameMatch[1]);
        console.log(
          '[gracefulRecovery] Found',
          frameKey,
          ':',
          (recovered as any)[frameKey].slice(0, 80),
        );
      } else {
        console.log('[gracefulRecovery] No match for', frameKey);
      }
    }

    // Try to extract action_plot with escaped quote handling
    console.log('[gracefulRecovery] Trying to extract action_plot...');
    const actionPlotRegex = /["']action_plot["']\s*:\s*"((?:[^"\\\\]|\\\\.)*)"$/i;
    const actionMatch = response.match(actionPlotRegex);
    if (actionMatch && actionMatch[1]) {
      recovered.action_plot = this.cleanEscapedChars(actionMatch[1]);
      console.log('[gracefulRecovery] Found action_plot:', recovered.action_plot.slice(0, 80));
    } else {
      console.log('[gracefulRecovery] No match for action_plot');
    }

    // Try to extract dialogues array with escaped quote handling
    console.log('[gracefulRecovery] Trying to extract dialogues...');
    const dialoguesRegex = /["']dialogues["']\s*:\s*\[([^\]]*)\]/;
    const dialoguesMatch = response.match(dialoguesRegex);
    if (dialoguesMatch && dialoguesMatch[1]) {
      console.log(
        '[gracefulRecovery] Found dialogues raw content:',
        dialoguesMatch[1].slice(0, 200),
      );
      // Try to extract individual dialogue texts from the matched array content
      const textRegex = /["']text["']\s*:\s*"((?:[^"\\\\]|\\\\.)*)"/g;
      let textMatch;
      while ((textMatch = textRegex.exec(dialoguesMatch[1])) !== null) {
        if (!recovered.dialogues) recovered.dialogues = [];
        (recovered.dialogues as { text: string }[]).push({
          text: this.cleanEscapedChars(textMatch[1]),
        });
        console.log(
          '[gracefulRecovery] Extracted dialogue:',
          (recovered.dialogues as { text: string }[]).length,
          '-',
          textMatch[1].slice(0, 60),
        );
      }
    } else {
      console.log('[gracefulRecovery] No match for dialogues');
    }

    // Try to extract audio_mood
    const moodRegex = /["']audio_mood["']\s*:\s*"((?:[^"\\\\]|\\\\.)*)"$/i;
    const moodMatch = response.match(moodRegex);
    if (moodMatch && moodMatch[1]) {
      recovered.audio_mood = this.cleanEscapedChars(moodMatch[1]);
      console.log('[gracefulRecovery] Found audio_mood:', recovered.audio_mood);
    }

    // Check if we found at least some data
    const hasAnyContent =
      recovered.frame1_description ||
      recovered.frame2_description ||
      recovered.frame3_description ||
      recovered.frame4_description;

    const filledFields = [
      recovered.character_appearance,
      recovered.costume_outfit,
      recovered.action_plot,
      recovered.dialogues,
      recovered.audio_mood,
    ].filter((f) => f !== undefined && f !== null).length;
    console.log('[gracefulRecovery] Total fields found:', filledFields, '/ 5');

    if (hasAnyContent) {
      console.log('[gracefulRecovery] *** Successfully recovered partial scene data ***');
    } else {
      // Even if we couldn't extract structured data, try to use the first meaningful sentence as title
      const sentences = response
        .split(/[.!?。！？\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 10);
      console.log(
        '[gracefulRecovery] No frame descriptions found, tried',
        sentences.length,
        'sentences',
      );
      if (sentences.length > 0) {
        recovered.scene_title = `Scene ${chunkIndex}: ${sentences[0].slice(0, 50)}`;
      }
    }

    console.log('[gracefulRecovery] Recovered scene:', JSON.stringify(recovered));
    console.log('[gracefulRecovery] ========== END ==========');
    return recovered;
  }

  /** Replace escaped quotes and other escape sequences for display */
  private cleanEscapedChars(str: string): string {
    return str.replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
  }

  private async callOllama(systemPrompt: string, userPrompt: string): Promise<string> {
    console.log('[callOllama] >>> Model:', this.ollamaModel || '(default qwen3-vl-nsfw)');
    console.log('[callOllama] >>> Base URL:', this.ollamaBaseUrl);
    console.log('[callOllama] >>> Timeout:', this.timeoutMs, 'ms');

    try {
      const result = await ollamaGenerate(
        this.ollamaBaseUrl,
        this.ollamaModel || 'qwen3-vl-nsfw:latest',
        systemPrompt,
        userPrompt,
        this.timeoutMs,
      );
      console.log('[callOllama] >>> Ollama returned successfully, length:', result.length);
      return result;
    } catch (error) {
      const err = error as any;
      console.error('[callOllama] >>> Error calling Ollama:', err.message || String(err));
      throw error;
    }
  }

  private extractDialoguesFromText(text: string): Array<{ text: string }> {
    const dialogues: Array<{ text: string }> = [];

    const quoteRegex = /["「]([^"」]+)["」]/g;
    let match;

    while ((match = quoteRegex.exec(text)) !== null) {
      if (match[1].trim().length > 0) {
        dialogues.push({ text: match[1].trim() });
      }
    }

    if (dialogues.length === 0 && text.trim()) {
      const lines = text.split(/[;；\n]/).filter((l) => l.trim().length > 2);
      for (const line of lines) {
        dialogues.push({ text: line.trim() });
      }
    }

    return dialogues.slice(0, 6);
  }

  private truncateForPrompt(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars - 50) + '\n\n... [truncated]';
  }
}

// Default instance for convenience
export const sceneExtractor = new SceneExtractor();
