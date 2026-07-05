/**
 * Storyboard Generator
 * AI 自动阅读整书生成分镜剧本的主控制器（v3 增量式）
 */

import { streamText } from 'ai';
import type { AISettings } from '../types';
import { getAIProvider } from '../providers';
import { SceneExtractor } from './sceneExtractor';
import type { BookScene, ContinuationContext } from './types';

/**
 * 将 HTML 内容转换为纯文本
 * 去除 HTML 标签，保留可读的文本内容
 */
function htmlToPlainText(html: string): string {
  // 移除 script 和 style 标签及其内容
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');

  // 移除 HTML 标签，用空格替换
  text = text.replace(/<[^>]+>/g, ' ');

  // 处理常见的 HTML 实体
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&/g, '&');
  text = text.replace(/</g, '<');
  text = text.replace(/>/g, '>');
  text = text.replace(/"/g, '"');
  text = text.replace(/&#39;/g, "'");

  // 移除多余的空行和空白字符
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.trim();

  return text;
}

import { STORYBOARD_SYSTEM_PROMPT, buildStoryboardUserPrompt, JSON_REPAIR_PROMPT } from './prompts';
import type { StoryboardJSON, StoryboardProgress } from './types';
import { validateAndParseJSON, extractJSONFromResponse } from './jsonValidator';

/**
 * 分镜生成器配置
 */
export interface StoryboardGeneratorConfig {
  // 最大并发生成数
  maxConcurrency: number;
  // 每次重试的最大次数
  maxRetries: number;
  // 是否启用场景验证
  enableSceneValidation: boolean;
  /** 每个章节分段的文本大小（字符数），默认 3000 */
  segmentSize: number;
}

const DEFAULT_CONFIG: StoryboardGeneratorConfig = {
  maxConcurrency: 1,
  maxRetries: 3,
  enableSceneValidation: true,
  segmentSize: 3000,
};

/**
 * 分镜生成器主类（v3：增量式分段提取）
 */
export class StoryboardGenerator {
  private settings: AISettings;
  private extractor: SceneExtractor;
  private config: StoryboardGeneratorConfig;

  constructor(settings: AISettings, config?: Partial<StoryboardGeneratorConfig>) {
    this.settings = settings;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.extractor = new SceneExtractor({ settings });

    // 输出详细的 AI 设置信息用于调试
    console.log('[StoryboardGenerator] Initialized with settings:', {
      provider: settings.provider,
      enabled: settings.enabled,
      ollamaModel: settings.ollamaModel,
      ollamaBaseUrl: settings.ollamaBaseUrl,
      ollamaEmbeddingModel: settings.ollamaEmbeddingModel,
      aiGatewayModel: settings.aiGatewayModel,
      aiGatewayApiKey: settings.aiGatewayApiKey ? '[REDACTED]' : undefined,
    });
  }

  /**
   * 从整本书生成分镜剧本（主入口 - v3 增量式）
   *
   * 工作流程：
   * 1. 将书籍内容按 segmentSize 拆分为多个段落片段
   * 2. 逐段调用 SceneExtractor.extractIncremental() 增量提取场景
   * 3. 每段结束时，将 lastContinuityContext 传递给下一段继续处理
   * 4. 最终将所有 BookScene 汇总后生成分镜 JSON
   */
  async generateFromBook(
    bookDoc: any,
    bookHash: string,
    _bookTitle: string,
    onProgress?: (progress: StoryboardProgress) => void,
  ): Promise<StoryboardJSON[]> {
    const startTime = Date.now();

    console.log('[StoryboardGenerator] ===== generateFromBook START =====');
    console.log('[StoryboardGenerator] Input:', {
      bookHash,
      bookTitle: _bookTitle,
      bookDocType: typeof bookDoc,
      bookDocLength: Array.isArray(bookDoc)
        ? bookDoc.length
        : typeof bookDoc === 'string'
          ? bookDoc.length
          : 'object',
    });

    // Step 1: 将书籍内容按 segmentSize 拆分为段落片段
    console.log('[StoryboardGenerator] Step 1: Splitting content by size...');
    const segments = await this.splitContentBySize(bookDoc, this.config.segmentSize);
    console.log(
      `[StoryboardGenerator] ✓ Split into ${segments.length} segments (size=${this.config.segmentSize})`,
    );
    if (segments.length > 0) {
      console.log(
        '[StoryboardGenerator] Segment sizes:',
        segments.map((s, i) => `seg${i}:${s.content.length}`).join(', '),
      );
    }

    if (segments.length === 0) {
      console.error('[StoryboardGenerator] ✗ ERROR: No content to process after splitting!');
      return [];
    }

    // Step 2: 逐段增量提取场景，并传递连续性上下文
    console.log('[StoryboardGenerator] Step 2: Starting incremental scene extraction...');
    const allScenes: BookScene[] = [];
    let lastContinuityContext: ContinuationContext | null = null;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      console.log(`\n[StoryboardGenerator] >>> Processing segment ${i + 1}/${segments.length} <<<`);
      console.log(
        `[StoryboardGenerator]   Segment content length: ${segment.content.length} chars`,
      );
      console.log(
        `[StoryboardGenerator]   Continuity context from previous: ${lastContinuityContext ? 'YES' : 'NO'}`,
      );
      if (lastContinuityContext) {
        console.log('[StoryboardGenerator]   Context:', {
          lastSceneTitle: lastContinuityContext.lastSceneTitle.substring(0, 30),
          hasCharacterAppearance: !!lastContinuityContext.characterAppearance,
          hasCostumeOutfit: !!lastContinuityContext.costumeOutfit,
        });
      }

      onProgress?.({
        phase: 'extracting',
        current: i,
        total: segments.length,
        completedScenes: allScenes.length,
        failedScenes: 0,
      });

      try {
        console.log('[StoryboardGenerator]   Calling extractor.extractIncremental()...');
        const result = await this.extractor.extractIncremental(
          segment.content,
          bookHash,
          i, // chapterIndex (segment index)
          _bookTitle || 'Untitled',
          lastContinuityContext,
        );

        console.log(`[StoryboardGenerator]   extractIncremental returned:`, {
          scenesCount: result.scenes?.length ?? 0,
          hasContinuityContext: !!result.lastContinuityContext,
        });

        if (result.scenes && result.scenes.length > 0) {
          allScenes.push(...result.scenes);
          console.log(
            `[StoryboardGenerator]   ✓ Added ${result.scenes.length} scenes to total (${allScenes.length} total)`,
          );
          // Log first scene details for debugging
          const firstScene = result.scenes[0]!;
          console.log('[StoryboardGenerator]   First scene:', {
            title: firstScene.chapterTitle,
            frame1Preview: firstScene.frame1_description?.substring(0, 50),
            hasCharacterAppearance: !!firstScene.character_appearance,
          });
        } else {
          console.warn(`[StoryboardGenerator]   ⚠ Segment ${i + 1}: no new scenes extracted`);
        }

        // Pass the last continuity context to the next segment for cross-segment consistency
        lastContinuityContext = result.lastContinuityContext;

        onProgress?.({
          phase: 'extracting',
          current: i + 1,
          total: segments.length,
          completedScenes: allScenes.length,
          failedScenes: 0,
        });
      } catch (error) {
        console.error(`[StoryboardGenerator]   ✗ ERROR extracting from segment ${i + 1}:`, error);
        console.error('[StoryboardGenerator]   Error stack:', (error as Error).stack);
        onProgress?.({
          phase: 'extracting',
          current: i + 1,
          total: segments.length,
          completedScenes: allScenes.length,
          failedScenes: (onProgress as any)?.failedScenes
            ? ((onProgress as any).failedScenes as number) + 1
            : 1,
        });
      }

      // 添加延迟避免 Ollama 过载（段间停顿）
      if (i < segments.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    console.log(`\n[StoryboardGenerator] ===== Step 2 Complete =====`);
    console.log(`[StoryboardGenerator] Total extracted scenes: ${allScenes.length}`);

    // Step 3: generate storyboard JSON for each scene
    if (allScenes.length === 0) {
      console.error('[StoryboardGenerator] ✗ ERROR: No scenes extracted from the book!');
      return [];
    }

    console.log(
      `[StoryboardGenerator] Step 3: Starting storyboard generation for ${allScenes.length} scenes...`,
    );
    onProgress?.({
      phase: 'generating',
      current: 0,
      total: allScenes.length,
      completedScenes: 0,
      failedScenes: 0,
    });

    const storyboards: StoryboardJSON[] = [];
    let failedCount = 0;

    console.log(
      '[StoryboardGenerator]   Scene list preview:',
      allScenes
        .slice(0, 3)
        .map((s, i) => `#${i + 1}: ${s.chapterTitle.substring(0, 20)}`)
        .join(', '),
    );

    await this.processWithConcurrency(
      allScenes,
      async (scene: BookScene, index) => {
        console.log(
          `[StoryboardGenerator]   >>> Generating storyboard for scene ${index + 1}/${allScenes.length} <<<`,
        );
        try {
          const storyboard = await this.generateSingleStoryboard(scene);
          storyboards.push(storyboard);
          console.log(
            `[StoryboardGenerator]   ✓ Scene ${index + 1} storyboard generated successfully`,
          );

          onProgress?.({
            phase: 'generating',
            current: index + 1,
            total: allScenes.length,
            completedScenes: storyboards.length,
            failedScenes: failedCount,
          });
        } catch (error) {
          failedCount++;
          console.error(
            `[StoryboardGenerator]   ✗ ERROR generating storyboard for scene ${index + 1}:`,
            error,
          );
          console.error('[StoryboardGenerator]   Scene details:', {
            id: scene.id,
            chapterTitle: scene.chapterTitle,
            hasFrames: !!scene.frame1_description,
          });

          onProgress?.({
            phase: 'generating',
            current: index + 1,
            total: allScenes.length,
            completedScenes: storyboards.length,
            failedScenes: failedCount,
            errorMessage: (error as Error).message,
          });
        }
      },
      this.config.maxConcurrency,
    );

    const duration = Date.now() - startTime;
    console.log(`\n[StoryboardGenerator] ===== generateFromBook COMPLETE =====`);
    console.log(`[StoryboardGenerator] Total time: ${duration}ms`);
    console.log(
      `[StoryboardGenerator] Result: ${storyboards.length}/${allScenes.length} storyboards generated`,
    );
    if (failedCount > 0) {
      console.warn(`[StoryboardGenerator] ⚠ ${failedCount} scenes failed to generate`);
    }

    return storyboards;
  }

  /**
   * 将书籍内容按 segmentSize 拆分为段落片段
   */
  private async splitContentBySize(
    bookDoc: any,
    segmentSize: number,
  ): Promise<{ content: string }[]> {
    console.log('[StoryboardGenerator]   [splitContentBySize] Input bookDoc type:', typeof bookDoc);

    // Check if this is a BookDoc object (has sections array with loadText functions)
    const isBookDoc =
      bookDoc &&
      typeof bookDoc === 'object' &&
      Array.isArray(bookDoc.sections) &&
      bookDoc.sections.length > 0;

    let totalContent: string;

    if (isBookDoc) {
      console.log(
        `[StoryboardGenerator]   [splitContentBySize] ✓ Detected BookDoc with ${bookDoc.sections.length} sections`,
      );

      // Load all section texts asynchronously
      const sectionContents: string[] = [];
      for (let i = 0; i < bookDoc.sections.length; i++) {
        const section = bookDoc.sections[i];
        console.log(
          `[StoryboardGenerator]   [splitContentBySize]   Section ${i}: id=${section.id}, size=${section.size}, href=${section.href || 'N/A'}`,
        );

        if (typeof section.loadText === 'function') {
          try {
            const text = await section.loadText();
            if (text && text.trim().length > 0) {
              // Convert HTML to plain text for Ollama processing
              const plainText = htmlToPlainText(text);
              const trimmedText = plainText.trim();
              sectionContents.push(trimmedText);
              // Log original content preview: first 200 chars + last 200 chars
              const totalLen = trimmedText.length;
              let logContent: string;
              if (totalLen <= 400) {
                logContent = trimmedText;
              } else {
                logContent =
                  trimmedText.substring(0, 200) +
                  ' ... (' +
                  totalLen +
                  ' chars) ... ' +
                  trimmedText.substring(totalLen - 200);
              }
              console.log(
                `[StoryboardGenerator]   [splitContentBySize]     ✓ Section ${i} Plain Text (${totalLen} chars):`,
              );
              console.log(`[StoryboardGenerator]   [splitContentBySize]        "${logContent}"`);
            } else {
              console.warn(
                `[StoryboardGenerator]   [splitContentBySize]     ⚠ Section ${i}: empty or invalid text`,
              );
            }
          } catch (error) {
            console.error(
              `[StoryboardGenerator]   [splitContentBySize]     ✗ Failed to load section ${i}:`,
              error,
            );
          }
        } else {
          console.warn(
            `[StoryboardGenerator]   [splitContentBySize]     ⚠ Section ${i}: no loadText function`,
          );
        }
      }

      totalContent = sectionContents.join('\n\n');
      // Log combined content preview: first 200 chars + last 200 chars
      const totalLen = totalContent.length;
      let logContent: string;
      if (totalLen <= 400) {
        logContent = totalContent;
      } else {
        logContent =
          totalContent.substring(0, 200) +
          ' ... (' +
          totalLen +
          ' chars) ... ' +
          totalContent.substring(totalLen - 200);
      }
      console.log(
        `[StoryboardGenerator]   [splitContentBySize] ✓ Loaded ${sectionContents.length} sections, total: ${totalLen} chars: "${logContent}"`,
      );
    } else if (typeof bookDoc === 'string') {
      // Log content preview for string input: first 200 chars + last 200 chars
      const totalLen = bookDoc.length;
      let logContent: string;
      if (totalLen <= 400) {
        logContent = bookDoc;
      } else {
        logContent =
          bookDoc.substring(0, 200) +
          ' ... (' +
          totalLen +
          ' chars) ... ' +
          bookDoc.substring(totalLen - 200);
      }
      console.log(
        `[StoryboardGenerator]   [splitContentBySize] ✓ BookDoc is string (${totalLen} chars): "${logContent}"`,
      );
      totalContent = bookDoc;
    } else if (Array.isArray(bookDoc)) {
      console.log(
        `[StoryboardGenerator]   [splitContentBySize] ✓ BookDoc is array (${bookDoc.length} items)`,
      );
      totalContent = bookDoc.join('\n\n');
      console.log(
        `[StoryboardGenerator]   [splitContentBySize] Joined content: ${totalContent.length} chars`,
      );
    } else if (typeof bookDoc === 'object' && bookDoc !== null) {
      console.log(
        '[StoryboardGenerator]   [splitContentBySize] BookDoc is object, extracting values...',
      );
      const values: string[] = [];
      for (const key of Object.keys(bookDoc)) {
        const v = (bookDoc as Record<string, unknown>)[key];
        if (typeof v === 'string') {
          values.push(v);
          console.log(
            `[StoryboardGenerator]   [splitContentBySize]   Key "${key}": string (${v.length} chars)`,
          );
        } else if (Array.isArray(v)) {
          const strings = v.filter((x: any): x is string => typeof x === 'string');
          values.push(...strings);
          console.log(
            `[StoryboardGenerator]   [splitContentBySize]   Key "${key}": array (${strings.length} strings)`,
          );
        } else {
          console.log(
            `[StoryboardGenerator]   [splitContentBySize]   Key "${key}": ${typeof v} (skipped)`,
          );
        }
      }
      totalContent = values.join('\n\n');
      console.log(
        `[StoryboardGenerator]   [splitContentBySize] ✓ Extracted ${values.length} values, total: ${totalContent.length} chars`,
      );
    } else {
      console.error(
        '[StoryboardGenerator]   [splitContentBySize] ✗ Book document type not supported:',
        typeof bookDoc,
      );
      return [];
    }

    if (totalContent.length === 0) {
      console.error(
        '[StoryboardGenerator]   [splitContentBySize] ✗ ERROR: No content extracted from bookDoc!',
      );
      return [];
    }

    // Log final content before splitting into segments: first 200 chars + last 200 chars
    const totalLen = totalContent.length;
    let logContent: string;
    if (totalLen <= 400) {
      logContent = totalContent;
    } else {
      logContent =
        totalContent.substring(0, 200) +
        ' ... (' +
        totalLen +
        ' chars) ... ' +
        totalContent.substring(totalLen - 200);
    }
    console.log(
      `[StoryboardGenerator]   [splitContentBySize] Final content ready: ${totalLen} chars: "${logContent}"`,
    );

    // Step B: split by paragraphs respecting segmentSize boundary
    const segments: { content: string }[] = [];

    if (totalContent.length <= segmentSize) {
      segments.push({ content: totalContent });
      return segments;
    }

    // Split into paragraphs first, then group them
    const paragraphs = totalContent.split(/\n\n+/).filter((p) => p.trim().length > 10);

    if (paragraphs.length === 0) {
      // Fallback: split by character count at paragraph boundaries
      for (let i = 0; i < totalContent.length; i += segmentSize) {
        const chunk = totalContent.substring(i, Math.min(i + segmentSize * 2, totalContent.length));
        if (chunk.trim().length > 100) {
          segments.push({ content: chunk });
        }
      }
    } else {
      let currentSegment = '';

      for (const para of paragraphs) {
        // If adding this paragraph exceeds segmentSize, start a new segment
        if (
          currentSegment.length > 0 &&
          currentSegment.length + '\n\n'.length + para.length > segmentSize
        ) {
          segments.push({ content: currentSegment.trim() });
          currentSegment = '';
        }

        currentSegment += (currentSegment ? '\n\n' : '') + para;
      }

      // Push remaining content
      if (currentSegment.trim().length > 50) {
        segments.push({ content: currentSegment.trim() });
      }
    }

    return segments;
  }

  /**
   * 生成单个分镜（公开方法）
   */
  async generateSingleStoryboard(scene: BookScene, maxRetries?: number): Promise<StoryboardJSON> {
    const retries = maxRetries ?? this.config.maxRetries;
    const prompt = buildStoryboardUserPrompt(scene);

    // Log the prompt being sent to Ollama (first 200 chars + last 200 chars)
    const promptLen = prompt.length;
    let promptLog: string;
    if (promptLen <= 400) {
      promptLog = prompt;
    } else {
      const first200 = prompt.substring(0, 200).replace(/\n/g, ' ');
      const last200 = prompt.substring(promptLen - 200).replace(/\n/g, ' ');
      promptLog = `${first200} ... (${promptLen} 字符) ... ${last200}`;
    }
    console.log(
      `[StoryboardGenerator]   [generateSingleStoryboard] Sending to Ollama (${promptLen} chars):`,
    );
    console.log(`[StoryboardGenerator]   [generateSingleStoryboard] Prompt: "${promptLog}"`);

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const provider = getAIProvider(this.settings);
        if (!provider) {
          throw new Error('No AI providers available. Please configure at least one provider.');
        }

        const model = provider.getModel();
        const result = streamText({
          model,
          system: STORYBOARD_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3, // 较低温度保证输出稳定
        });

        const textChunks: string[] = [];
        for await (const chunk of result.textStream) {
          textChunks.push(String(chunk));
        }
        const responseText = textChunks.join('');
        const jsonStr = extractJSONFromResponse(responseText);

        if (!jsonStr) {
          throw new Error('No JSON found in LLM response');
        }

        const validation = validateAndParseJSON(jsonStr, retries - attempt);

        if (validation.valid && validation.corrected) {
          return validation.corrected;
        }

        // 重试：使用修复提示词
        if (attempt < retries) {
          console.log(
            `[StoryboardGenerator] Retry ${attempt + 1}/${retries} for scene ${scene.id}`,
          );

          const repairPrompt = JSON_REPAIR_PROMPT.replace(
            '{error_message}',
            validation.errors.join(', '),
          ).replace('{original_input}', prompt);

          // 重新调用 LLM 进行修复
          const repairModel = provider.getModel();
          const repairResult = streamText({
            model: repairModel,
            system: '你是一个 JSON 修复专家，只输出合法的 JSON',
            messages: [{ role: 'user', content: repairPrompt }],
            temperature: 0.1,
          });

          const repairChunks: string[] = [];
          for await (const chunk of repairResult.textStream) {
            repairChunks.push(String(chunk));
          }
          const repairResponse = repairChunks.join('');
          const repairedJsonStr = extractJSONFromResponse(repairResponse);

          if (repairedJsonStr) {
            const repairValidation = validateAndParseJSON(repairedJsonStr, 0);
            if (repairValidation.valid && repairValidation.corrected) {
              return repairValidation.corrected;
            }
          }
        }
      } catch (error) {
        console.error(`[StoryboardGenerator] Attempt ${attempt + 1} failed:`, error);

        if (attempt === retries) {
          throw new Error(
            `Failed to generate storyboard after ${retries + 1} attempts: ${(error as Error).message}`,
          );
        }
      }
    }

    throw new Error('Failed to generate storyboard');
  }

  /**
   * 顺序处理数组元素（避免 Ollama 过载）
   */
  private async processWithConcurrency<T>(
    items: T[],
    processor: (item: T, index: number) => Promise<void>,
    _concurrency: number,
  ): Promise<void> {
    for (let i = 0; i < items.length; i++) {
      console.log(`[StoryboardGenerator] Processing scene ${i + 1}/${items.length}`);

      try {
        await processor(items[i]!, i);
      } catch (error) {
        console.error(`[StoryboardGenerator] Failed to process scene ${i}:`, error);
      }

      // 添加延迟避免 Ollama 过载
      if (i < items.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  /**
   * 从单个场景生成分镜（简化接口）
   */
  async generateFromScene(scene: BookScene): Promise<StoryboardJSON> {
    return this.generateSingleStoryboard(scene);
  }

  /**
   * 批量生成分镜（不限制并发）
   */
  async generateBatch(scenes: BookScene[]): Promise<StoryboardJSON[]> {
    const results = await Promise.allSettled(
      scenes.map((scene: BookScene) => this.generateSingleStoryboard(scene)),
    );

    return results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<StoryboardJSON>).value);
  }
}
