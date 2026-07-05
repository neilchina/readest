/**
 * Storyboard Generator
 * AI 自动阅读整书生成分镜剧本的主控制器
 */

import { streamText } from 'ai';
import type { AISettings, StoryboardJSON, StoryboardProgress } from './types';
import { getAIProvider } from '../providers';
import { SceneExtractor } from './sceneExtractor';
import type { BookScene } from './types';
import { STORYBOARD_SYSTEM_PROMPT, buildStoryboardUserPrompt, JSON_REPAIR_PROMPT } from './prompts';
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
}

const DEFAULT_CONFIG: StoryboardGeneratorConfig = {
  maxConcurrency: 1,
  maxRetries: 3,
  enableSceneValidation: true,
};

/**
 * 分镜生成器主类
 */
export class StoryboardGenerator {
  private settings: AISettings;
  private extractor: SceneExtractor;
  private config: StoryboardGeneratorConfig;

  constructor(settings: AISettings, config?: Partial<StoryboardGeneratorConfig>) {
    this.settings = settings;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.extractor = new SceneExtractor(settings);

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
   * 从整本书生成分镜剧本（主入口）- v3 Incremental
   */
  async generateFromBook(
    bookDoc: any,
    _bookHash: string,
    _bookTitle: string,
    onProgress?: (progress: StoryboardProgress) => void,
  ): Promise<StoryboardJSON[]> {
    const startTime = Date.now();

    // Validate and normalize bookDoc input
    let contentArray: string[];
    if (typeof bookDoc === 'string') {
      const parts = bookDoc.split(/\r?\n/).filter((line) => line.trim().length > 0);
      contentArray = parts;
      console.log(`[StoryboardGenerator] String document split into ${parts.length} chapters`);
    } else if (Array.isArray(bookDoc)) {
      contentArray = bookDoc;
    } else if (typeof bookDoc === 'object' && bookDoc !== null) {
      const values: any[] = [];
      for (const key of Object.keys(bookDoc)) {
        const v = (bookDoc as Record<string, unknown>)[key];
        if (typeof v === 'string') values.push(v);
        else if (Array.isArray(v)) values.push(...v);
      }
      contentArray = values;
    } else {
      console.warn(
        '[StoryboardGenerator] Book document is not a string, array or object, skipping.',
      );
      contentArray = [];
    }

    const totalContent = contentArray.join('\n\n');

    // v3: 分段增量式分镜提取（防止响应超长截断）
    const allScenes = await this.extractIncrementalScenes(
      totalContent,
      _bookTitle || 'Untitled',
      onProgress,
    );

    console.log(`[StoryboardGenerator] Incrementally extracted ${allScenes.length} total scenes`);

    if (allScenes.length === 0) {
      console.warn('[StoryboardGenerator] No scenes extracted from the book');
      return [];
    }

    // 合并相邻重复场景（v3 continuity 修复：跨段首尾重复）
    const dedupedScenes = this.deduplicateAdjacentScenes(allScenes);
    console.log(`[StoryboardGenerator] After dedup: ${dedupedScenes.length} scenes`);

    // 按 id 排序确保顺序稳定
    dedupedScenes.sort((a, b) => {
      const numA = parseInt(a.id || '0', 10);
      const numB = parseInt(b.id || '0', 10);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.id.localeCompare(b.id);
    });

    console.log('[StoryboardGenerator] Starting storyboard generation...');
    onProgress?.({
      phase: 'generating',
      current: 0,
      total: dedupedScenes.length,
      completedScenes: 0,
      failedScenes: 0,
    });

    const storyboards: StoryboardJSON[] = [];
    let failedCount = 0;

    await this.processWithConcurrency(
      dedupedScenes,
      async (scene: BookScene, index) => {
        try {
          const storyboard = await this.generateSingleStoryboard(scene);
          storyboards.push(storyboard);

          onProgress?.({
            phase: 'generating',
            current: index + 1,
            total: dedupedScenes.length,
            completedScenes: storyboards.length,
            failedScenes: failedCount,
          });
        } catch (error) {
          failedCount++;
          console.error(
            `[StoryboardGenerator] Failed to generate storyboard for scene ${scene.id}:`,
            error,
          );

          onProgress?.({
            phase: 'generating',
            current: index + 1,
            total: dedupedScenes.length,
            completedScenes: storyboards.length,
            failedScenes: failedCount,
            errorMessage: (error as Error).message,
          });
        }
      },
      this.config.maxConcurrency,
    );

    const duration = Date.now() - startTime;
    console.log(
      `[StoryboardGenerator] Completed in ${duration}ms. Generated ${storyboards.length}/${dedupedScenes.length} storyboards.`,
    );

    return storyboards;
  }

  /**
   * v3 Incremental: 分段提取场景，跨段传递连续性上下文
   */
  private async extractIncrementalScenes(
    content: string,
    title: string,
    onProgress?: (progress: StoryboardProgress) => void,
  ): Promise<BookScene[]> {
    const MAX_CHUNK_SIZE = 3000; // token budget（与 sceneExtractor.ts 的 CHUNK_SIZE 一致）
    const chunks = this.splitContentBySize(content, MAX_CHUNK_SIZE);

    console.log(`[StoryboardGenerator] Split content into ${chunks.length} segments`);

    let lastContinuity:
      | {
          summary: string;
          keyCharacters: Record<string, CharacterAppearance>;
          lastFrame: FrameDescription;
        }
      | undefined = undefined;

    const allScenes: BookScene[] = [];

    for (let i = 0; i < chunks.length; i++) {
      console.log(`[StoryboardGenerator] Extracting segment ${i + 1}/${chunks.length}...`);

      try {
        const scenes = await this.extractor.extractIncremental({
          content: chunks[i],
          title: `${title} - Segment ${i + 1}`,
          continuationContext: lastContinuity,
        });

        allScenes.push(...scenes);

        // v3: 保存最后场景的上下文给下一段使用（连续性追踪）
        if (scenes.length > 0) {
          const lastScene = scenes[scenes.length - 1]!;
          const characterMap: Record<string, CharacterAppearance> = {};
          for (const [charId, charInfo] of Object.entries(lastScene.characterAppearances || {})) {
            characterMap[charId] = charInfo;
          }
          lastContinuity = {
            summary: lastScene.continuitySummary || '',
            keyCharacters: characterMap,
            lastFrame:
              lastScene.frames.length > 0
                ? lastScene.frames[lastScene.frames.length - 1]!
                : (undefined as any),
          };
        }

        onProgress?.({
          phase: 'extracting',
          current: i + 1,
          total: chunks.length,
          completedScenes: allScenes.length,
          failedScenes: 0,
        });
      } catch (error) {
        console.error(`[StoryboardGenerator] Failed to extract segment ${i + 1}:`, error);
        onProgress?.({
          phase: 'extracting',
          current: i + 1,
          total: chunks.length,
          completedScenes: allScenes.length,
          failedScenes: (i as number) + 1,
          errorMessage: (error as Error).message,
        });
      }
    }

    return allScenes;
  }

  /**
   * 按字符大小分割内容（适配中文）
   */
  private splitContentBySize(content: string, maxChunkSize: number): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < content.length) {
      const end = Math.min(start + maxChunkSize, content.length);
      // 尝试在句号处分割，避免截断句子
      let splitAt = end;
      if (end < content.length) {
        const lastPeriod = Math.max(
          content.lastIndexOf('。', end),
          content.lastIndexOf('！', end),
          content.lastIndexOf('？', end),
          content.lastIndexOf('\n\n', end),
        );
        if (lastPeriod > start + maxChunkSize / 2) {
          splitAt = lastPeriod + 1; // +1 to include the period
        }
      }

      const chunk = content.slice(start, splitAt).trim();
      if (chunk) chunks.push(chunk);
      start = splitAt;
    }

    return chunks.length > 0 ? chunks : [content];
  }

  /**
   * v3: 合并相邻重复场景（修复跨段首尾重复）
   */
  private deduplicateAdjacentScenes(scenes: BookScene[]): BookScene[] {
    if (scenes.length <= 1) return scenes;

    const result: BookScene[] = [];

    for (let i = 0; i < scenes.length; i++) {
      const current = scenes[i]!;

      // 检查与下一个场景是否重复（基于 sceneTitle + actionPlot 相似度）
      if (i + 1 < scenes.length) {
        const next = scenes[i + 1]!;

        // 简单去重：title 相同且 plot 高度重叠则跳过当前
        if (
          current.sceneTitle === next.sceneTitle ||
          this.isActionOverlap(current.actionPlot, next.actionPlot)
        ) {
          continue;
        }
      }

      result.push(current);
    }

    return result.length > 0 ? result : scenes;
  }

  /**
   * 检查两个剧情描述是否高度重叠（基于关键词）
   */
  private isActionOverlap(plotA: string, plotB: string): boolean {
    if (!plotA || !plotB) return false;

    // 计算重叠关键词比例
    const commonChars = new Set([...plotA].filter((c) => [...plotB].includes(c)));
    const ratio = commonChars.size / Math.max(plotA.length, plotB.length);

    // 70%+ 的字符重叠视为重复
    return ratio > 0.7;
  }

  /**
   * 生成单个分镜（公开方法）
   */
  async generateSingleStoryboard(scene: BookScene, maxRetries?: number): Promise<StoryboardJSON> {
    const retries = maxRetries ?? this.config.maxRetries;
    const prompt = buildStoryboardUserPrompt(scene);

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

        // 第一次尝试：严格模式解析
        let validation = validateAndParseJSON(jsonStr);

        if (!validation.valid) {
          // 非严格模式下自动修复常见 JSON 错误
          console.log(
            `[StoryboardGenerator] Validation attempt ${attempt + 1} failed:`,
            validation.errors.join(', '),
          );

          const repairPrompt = JSON_REPAIR_PROMPT.replace(
            '{error_message}',
            validation.errors.join(', '),
          ).replace('{original_input}', prompt);

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
            validation = validateAndParseJSON(repairedJsonStr);

            if (validation.valid && validation.corrected) {
              return validation.corrected;
            }
          }
        }

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
