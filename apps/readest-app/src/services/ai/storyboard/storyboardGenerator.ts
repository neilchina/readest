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
 */
function htmlToPlainText(html: string): string {
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&/g, '&');
  text = text.replace(/</g, '<');
  text = text.replace(/>/g, '>');
  text = text.replace(/"/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/\n\s*\n\s*\n/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');
  return text.trim();
}

import { STORYBOARD_SYSTEM_PROMPT, buildStoryboardUserPrompt } from './prompts';
import type { StoryboardJSON, StoryboardProgress } from './types';
import { validateAndParseJSON, extractJSONFromResponse } from './jsonValidator';

export interface StoryboardGeneratorConfig {
  maxConcurrency: number;
  maxRetries: number;
  enableSceneValidation: boolean;
  segmentSize: number;
}

const DEFAULT_CONFIG: StoryboardGeneratorConfig = {
  maxConcurrency: 1,
  maxRetries: 3,
  enableSceneValidation: true,
  segmentSize: 3000,
};

export class StoryboardGenerator {
  private settings: AISettings;
  private extractor: SceneExtractor;
  private config: StoryboardGeneratorConfig;
  private abortController: AbortController | null = null;

  constructor(settings: AISettings, config?: Partial<StoryboardGeneratorConfig>) {
    this.settings = settings;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.extractor = new SceneExtractor({ settings });
  }

  /**
   * 取消当前生成任务
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      console.log('[StoryboardGenerator] Generation cancelled');
    }
  }

  async generateFromBook(
    bookDoc: any,
    bookHash: string,
    _bookTitle: string,
    onProgress?: (progress: StoryboardProgress) => void,
  ): Promise<StoryboardJSON[]> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const startTime = Date.now();

    console.log('[StoryboardGenerator] ===== generateFromBook START =====');

    // Step 1: Split content
    const segments = await this.splitContentBySize(bookDoc, this.config.segmentSize);
    if (segments.length === 0) {
      console.error('[StoryboardGenerator] ✗ ERROR: No content to process!');
      return [];
    }

    const checkAbort = () => {
      if (signal.aborted) {
        throw new Error('Generation cancelled by user');
      }
    };

    // Step 2: Extract scenes
    console.log('[StoryboardGenerator] Step 2: Starting scene extraction...');
    const allScenes: BookScene[] = [];
    let lastContinuityContext: ContinuationContext | null = null;

    for (let i = 0; i < segments.length; i++) {
      checkAbort();

      onProgress?.({
        phase: 'extracting',
        current: i,
        total: segments.length,
        completedScenes: allScenes.length,
        failedScenes: 0,
      });

      try {
        const result = await this.extractor.extractIncremental(
          segments[i]!.content,
          bookHash,
          i,
          _bookTitle || 'Untitled',
          lastContinuityContext,
        );

        if (result.scenes && result.scenes.length > 0) {
          allScenes.push(...result.scenes);
        }
        lastContinuityContext = result.lastContinuityContext;

        onProgress?.({
          phase: 'extracting',
          current: i + 1,
          total: segments.length,
          completedScenes: allScenes.length,
          failedScenes: 0,
        });
      } catch (error) {
        if ((error as Error).message === 'Generation cancelled by user') {
          throw error;
        }
        console.error(`[StoryboardGenerator] Error extracting segment ${i + 1}:`, error);
      }

      // Delay between segments with abort support
      if (i < segments.length - 1) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, 2000);
          signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new Error('Generation cancelled'));
          });
        });
      }
    }

    if (allScenes.length === 0) {
      console.error('[StoryboardGenerator] ✗ ERROR: No scenes extracted!');
      return [];
    }

    // Step 3: Generate storyboards
    console.log(`[StoryboardGenerator] Step 3: Generating ${allScenes.length} storyboards...`);
    onProgress?.({
      phase: 'generating',
      current: 0,
      total: allScenes.length,
      completedScenes: 0,
      failedScenes: 0,
    });

    const storyboards: StoryboardJSON[] = [];
    let failedCount = 0;

    for (let i = 0; i < allScenes.length; i++) {
      checkAbort();

      try {
        const storyboard = await this.generateSingleStoryboard(allScenes[i]!);
        storyboards.push(storyboard);

        onProgress?.({
          phase: 'generating',
          current: i + 1,
          total: allScenes.length,
          completedScenes: storyboards.length,
          failedScenes: failedCount,
        });
      } catch (error) {
        if ((error as Error).message === 'Generation cancelled by user') {
          throw error;
        }
        failedCount++;
        console.error(`[StoryboardGenerator] Error generating storyboard ${i + 1}:`, error);
      }

      // Delay between scenes with abort support
      if (i < allScenes.length - 1) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, 2000);
          signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new Error('Generation cancelled'));
          });
        });
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `[StoryboardGenerator] ===== COMPLETE: ${storyboards.length}/${allScenes.length} in ${duration}ms =====`,
    );

    this.abortController = null;
    return storyboards;
  }

  private async splitContentBySize(
    bookDoc: any,
    segmentSize: number,
  ): Promise<{ content: string }[]> {
    const isBookDoc = bookDoc && typeof bookDoc === 'object' && Array.isArray(bookDoc.sections);

    if (isBookDoc) {
      const sectionContents: string[] = [];
      for (let i = 0; i < bookDoc.sections.length; i++) {
        const section = bookDoc.sections[i];
        if (typeof section.loadText === 'function') {
          try {
            const text = await section.loadText();
            if (text && text.trim().length > 0) {
              sectionContents.push(htmlToPlainText(text).trim());
            }
          } catch (error) {
            console.error(`Failed to load section ${i}:`, error);
          }
        }
      }
      return this.groupIntoSegments(sectionContents.join('\n\n'), segmentSize);
    } else if (typeof bookDoc === 'string') {
      return this.groupIntoSegments(bookDoc, segmentSize);
    } else if (Array.isArray(bookDoc)) {
      return this.groupIntoSegments(bookDoc.join('\n\n'), segmentSize);
    }

    return [];
  }

  private groupIntoSegments(content: string, segmentSize: number): { content: string }[] {
    const segments: { content: string }[] = [];
    if (content.length <= segmentSize) {
      return [{ content }];
    }

    const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 10);
    let currentSegment = '';

    for (const para of paragraphs) {
      if (currentSegment.length > 0 && currentSegment.length + 2 + para.length > segmentSize) {
        segments.push({ content: currentSegment.trim() });
        currentSegment = '';
      }
      currentSegment += (currentSegment ? '\n\n' : '') + para;
    }

    if (currentSegment.trim().length > 50) {
      segments.push({ content: currentSegment.trim() });
    }

    return segments.length > 0 ? segments : [{ content }];
  }

  async generateSingleStoryboard(scene: BookScene, maxRetries?: number): Promise<StoryboardJSON> {
    const retries = maxRetries ?? this.config.maxRetries;
    const prompt = buildStoryboardUserPrompt(scene);

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const provider = getAIProvider(this.settings);
        if (!provider) throw new Error('No AI providers available');

        const model = provider.getModel();
        const result = streamText({
          model,
          system: STORYBOARD_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
        });

        let responseText = '';
        for await (const chunk of result.textStream) {
          responseText += String(chunk);
        }

        const jsonStr = extractJSONFromResponse(responseText);
        if (!jsonStr) throw new Error('No JSON in response');

        const validation = validateAndParseJSON(jsonStr, retries - attempt);
        if (validation.valid && validation.corrected) {
          return validation.corrected;
        }

        if (attempt < retries) {
          console.log(`Retry ${attempt + 1}/${retries}`);
          // Retry logic...
        }
      } catch (error) {
        console.error(`Attempt ${attempt + 1} failed:`, error);
        if (attempt === retries) {
          throw new Error(`Failed after ${retries + 1} attempts`);
        }
      }
    }

    throw new Error('Failed to generate storyboard');
  }
}
