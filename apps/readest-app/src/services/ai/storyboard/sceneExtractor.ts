/**
 * Scene Extractor - 增量式场景提取器 v2
 * 从书籍文本中逐步提取分镜帧，累积满 4 帧后合成完整场景
 */

import { streamText } from 'ai';
import type { AISettings } from '../types';
import { getAIProvider } from '../providers';
import {
  FRAGMENT_FRAME_EXTRACTION_SYSTEM_PROMPT,
  buildFragmentUserPrompt,
  SCENE_COMPOSITION_PROMPT,
  JSON_REPAIR_PROMPT,
} from './prompts';
import type { BookScene, ContinuationContext, ExtractionResult } from './types';
import { validateAndParseJSON, extractJSONFromResponse } from './jsonValidator';

/**
 * SceneExtractor 配置选项
 */
export interface SceneExtractorOptions {
  settings?: AISettings;
  fragmentSize?: number; // 每个片段的最大字符数（默认：1500）
  maxRetries?: number; // 最大重试次数（默认：3）
}

const DEFAULT_FRAGMENT_SIZE = 1500;
const DEFAULT_MAX_RETRIES = 3;

/**
 * 累积的上下文状态 - 用于在片段间保持角色一致性
 */
interface AccumulatedContext {
  chapterTitle: string; // 章节标题
  bookHash: string; // 书籍哈希
  chapterIndex: number; // 章节索引
  frames: string[]; // 累积的帧描述（最多 4 个）
  frameDescriptions: string[]; // 帧详细描述数组
  characterAppearance: string; // 角色外貌
  costumeOutfit: string; // 服装描述
  plotSummary: string; // 剧情摘要
  sceneTitle: string; // 场景标题
}

/**
 * SceneExtractor - 增量式场景提取器 v2
 */
export class SceneExtractor {
  private aiSettings: AISettings;
  private fragmentSize: number;
  private maxRetries: number;

  constructor(options: SceneExtractorOptions = {}) {
    // 从设置或环境变量获取 AI 配置
    if (options.settings) {
      this.aiSettings = options.settings;
    } else {
      // 使用默认配置（从环境变量读取）
      this.aiSettings = {
        enabled: true,
        provider: 'ollama',
        ollamaModel: process.env['NEXT_PUBLIC_OLLAMA_MODEL'] || 'qwen3-vl-nsfw:latest',
        ollamaBaseUrl: process.env['NEXT_PUBLIC_OLLAMA_BASE_URL'] || '',
        ollamaEmbeddingModel: process.env['NEXT_PUBLIC_OLLAMA_EMBEDDING_MODEL'] || 'bge-m3:latest',
        spoilerProtection: true,
        maxContextChunks: 100,
        indexingMode: 'on-demand',
      };
    }

    this.fragmentSize = options.fragmentSize ?? DEFAULT_FRAGMENT_SIZE;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    console.log('[SceneExtractor] Initialized with settings:', {
      provider: this.aiSettings.provider,
      ollamaModel: this.aiSettings.ollamaModel,
      ollamaBaseUrl: this.aiSettings.ollamaBaseUrl || 'not set',
    });
  }

  /**
   * 将文本拆分为片段（按段落分割，控制每段大小）
   */
  splitIntoFragments(content: string): string[] {
    const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 10);
    const fragments: string[] = [];
    let currentFragment = '';

    for (const para of paragraphs) {
      if (currentFragment.length + para.length > this.fragmentSize && currentFragment.length > 0) {
        fragments.push(currentFragment.trim());
        currentFragment = para;
      } else {
        currentFragment += (currentFragment ? '\n\n' : '') + para;
      }
    }

    if (currentFragment.trim().length > 50) {
      fragments.push(currentFragment.trim());
    }

    console.log('[SceneExtractor] Split into', fragments.length, 'fragments');
    return fragments;
  }

  /**
   * 从单个片段提取单帧画面描述
   */
  async extractFrameFromFragment(fragment: string): Promise<string> {
    try {
      const provider = getAIProvider(this.aiSettings);
      if (!provider) {
        throw new Error('No AI providers available');
      }

      const model = provider.getModel();

      console.log('[SceneExtractor] [extractFrameFromFragment] Calling Ollama...');
      console.log(
        '[SceneExtractor] [extractFrameFromFragment] Fragment preview:',
        fragment.length > 200 ? fragment.substring(0, 200) + '...' : fragment,
      );

      const result = await streamText({
        model,
        messages: [
          { role: 'system', content: FRAGMENT_FRAME_EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: buildFragmentUserPrompt(fragment) },
        ],
        temperature: 0.2,
      });

      let frameDescription = '';
      for await (const chunk of result.textStream) {
        frameDescription += String(chunk);
      }

      // 清理输出（移除可能的"SKIP"或无关文本）
      const cleaned = frameDescription.trim();
      if (cleaned.toUpperCase() === 'SKIP') {
        console.log('[SceneExtractor] [extractFrameFromFragment] SKIP');
        return '';
      }

      console.log(
        '[SceneExtractor] [extractFrameFromFragment] Frame description:',
        cleaned.length > 200 ? cleaned.substring(0, 200) + '...' : cleaned,
      );

      return cleaned;
    } catch (error) {
      console.error('[SceneExtractor] [extractFrameFromFragment] Error:', error);
      throw error;
    }
  }

  /**
   * 将累积的 4 帧合成为一个场景 JSON
   */
  async composeScene(context: AccumulatedContext): Promise<BookScene | null> {
    if (context.frames.length < 4) {
      console.warn(
        '[SceneExtractor] [composeScene] Only',
        context.frames.length,
        'frames collected. Need 4.',
      );
      return null;
    }

    try {
      const provider = getAIProvider(this.aiSettings);
      if (!provider) {
        throw new Error('No AI providers available');
      }

      const model = provider.getModel();

      // 构建组合提示词
      const prompt = SCENE_COMPOSITION_PROMPT.replace('{chapter_title}', context.chapterTitle)
        .replace('{frame1_description}', context.frames[0] || '')
        .replace('{frame2_description}', context.frames[1] || '')
        .replace('{frame3_description}', context.frames[2] || '')
        .replace('{frame4_description}', context.frames[3] || '');

      console.log('[SceneExtractor] [composeScene] Calling Ollama for scene composition...');

      const result = await streamText({
        model,
        messages: [
          { role: 'system', content: '你是一个专业的电影分镜 JSON 生成器，只输出合法的 JSON' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
      });

      let responseText = '';
      for await (const chunk of result.textStream) {
        responseText += String(chunk);
      }

      const jsonStr = extractJSONFromResponse(responseText);
      if (!jsonStr) {
        throw new Error('No JSON found in response');
      }

      console.log(
        '[SceneExtractor] [composeScene] Raw JSON response:',
        jsonStr.length > 500 ? jsonStr.substring(0, 500) + '...' : jsonStr,
      );

      // 验证 JSON
      const validation = validateAndParseJSON(jsonStr, this.maxRetries);

      if (!validation.valid) {
        console.error('[SceneExtractor] [composeScene] ✗ JSON validation FAILED');
        console.error('[SceneExtractor] [composeScene] Validation errors:', validation.errors);

        // 重试修复逻辑（简化版）
        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
          console.log(`[SceneExtractor] [composeScene] Retry ${attempt + 1}/${this.maxRetries}`);

          const repairPrompt = JSON_REPAIR_PROMPT.replace(
            '{error_message}',
            validation.errors.join(', '),
          ).replace('{original_input}', jsonStr.substring(0, 1000));

          const repairResult = await streamText({
            model,
            messages: [
              { role: 'system', content: '你是一个 JSON 修复专家，只输出合法的 JSON' },
              { role: 'user', content: repairPrompt },
            ],
            temperature: 0.1,
          });

          let repairText = '';
          for await (const chunk of repairResult.textStream) {
            repairText += String(chunk);
          }

          const repairedJsonStr = extractJSONFromResponse(repairText);
          if (repairedJsonStr) {
            const repairValidation = validateAndParseJSON(repairedJsonStr, 0);
            if (repairValidation.valid && repairValidation.corrected) {
              console.log('[SceneExtractor] [composeScene] ✓ Repair successful');
              return this.mapToBookScene(repairValidation.corrected, context);
            }
          }
        }

        throw new Error('JSON validation failed after retries: ' + validation.errors.join(', '));
      }

      if (!validation.corrected) {
        throw new Error('Valid JSON but no corrected output');
      }

      console.log('[SceneExtractor] [composeScene] ✓ Scene composition successful');
      return this.mapToBookScene(validation.corrected, context);
    } catch (error) {
      console.error('[SceneExtractor] [composeScene] ✗ Error:', error);
      throw error;
    }
  }

  /**
   * 将 StoryboardJSON 映射为 BookScene
   */
  private mapToBookScene(storyboard: any, context: AccumulatedContext): BookScene {
    const scene = storyboard.scene_list?.[0];
    const shots = scene?.shot_list || [];

    return {
      id: `${context.bookHash}-scene-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      bookHash: context.bookHash,
      chapterIndex: context.chapterIndex,
      chapterTitle: context.chapterTitle,
      sectionStart: 0,
      sectionEnd: 0,

      frame1_description: shots[0]?.content || context.frames[0] || '',
      frame2_description: shots[1]?.content || context.frames[1] || '',
      frame3_description: shots[2]?.content || context.frames[2] || '',
      frame4_description: shots[3]?.content || context.frames[3] || '',

      character_appearance:
        scene?.shot_list?.[0]?.character_appearance || context.characterAppearance,
      costume_outfit: scene?.shot_list?.[0]?.character_costume || context.costumeOutfit,
      action_plot: scene?.scene_name || context.plotSummary,
      dialogues:
        shots
          .map((s: any) => s.dialogue)
          .filter(Boolean)
          .join(' | ') || '',
      audio_mood: scene?.ambient_sound || '',

      wordCount: context.frames.reduce((sum, f) => sum + f.length, 0),
      extractedAt: Date.now(),
    };
  }

  /**
   * 处理单个章节（增量式提取）
   */
  async processChapter(
    content: string,
    bookHash: string,
    chapterIndex: number,
    chapterTitle: string,
    continuityContext?: ContinuationContext | null,
  ): Promise<{ scenes: BookScene[]; lastContinuityContext: ContinuationContext | null }> {
    console.log('[SceneExtractor] [processChapter] Processing chapter:', chapterTitle);

    const fragments = this.splitIntoFragments(content);
    const accumulatedContext: AccumulatedContext = {
      chapterTitle,
      bookHash,
      chapterIndex,
      frames: [],
      frameDescriptions: [],
      characterAppearance: continuityContext?.characterAppearance || '',
      costumeOutfit: continuityContext?.costumeOutfit || '',
      plotSummary: '',
      sceneTitle: '',
    };

    const scenes: BookScene[] = [];

    for (let i = 0; i < fragments.length; i++) {
      const fragment = fragments[i]!;

      console.log(
        `[SceneExtractor] [processChapter] Processing fragment ${i + 1}/${fragments.length}`,
      );

      try {
        const frameDescription = await this.extractFrameFromFragment(fragment);

        if (frameDescription) {
          accumulatedContext.frames.push(frameDescription);
          accumulatedContext.frameDescriptions.push(frameDescription);

          console.log(
            `[SceneExtractor] [processChapter] Frame ${accumulatedContext.frames.length}/4 collected`,
          );

          // 累积满 4 帧后合成场景
          if (accumulatedContext.frames.length >= 4) {
            const scene = await this.composeScene(accumulatedContext);
            if (scene) {
              scenes.push(scene);
              console.log('[SceneExtractor] [processChapter] ✓ Scene', scenes.length, 'created');
            }

            // 重置累积上下文，保留角色信息用于下一场景
            accumulatedContext.frames = [];
            accumulatedContext.frameDescriptions = [];
          }
        } else {
          console.log('[SceneExtractor] [processChapter] SKIP - no frame extracted');
        }
      } catch (error) {
        console.error('[SceneExtractor] [processChapter] Error processing fragment:', error);
      }

      // 添加延迟避免 Ollama 过载
      if (i < fragments.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // 章节结束时，如果还有未完成的帧（不足 4 个），丢弃它们
    if (accumulatedContext.frames.length > 0 && accumulatedContext.frames.length < 4) {
      console.warn(
        '[SceneExtractor] [processChapter] ⚠ Only',
        accumulatedContext.frames.length,
        '/4 frames collected at chapter end. These frames will be discarded.',
      );
    }

    // 构建连续性上下文供下一章节使用
    const lastContinuityContext: ContinuationContext | null =
      scenes.length > 0
        ? {
            characterAppearance: accumulatedContext.characterAppearance,
            costumeOutfit: accumulatedContext.costumeOutfit,
            lastSceneTitle:
              accumulatedContext.sceneTitle || scenes[scenes.length - 1]?.chapterTitle || '',
            plotSummary: accumulatedContext.plotSummary,
            lastFragmentEnd: content.length,
          }
        : null;

    if (lastContinuityContext) {
      console.log('[SceneExtractor] [processChapter] ✓ Continuity context passed to next chapter');
    } else {
      console.warn(
        '[SceneExtractor] [processChapter] ⚠ No scenes extracted, no continuity context to pass',
      );
    }

    return { scenes, lastContinuityContext };
  }

  /**
   * 增量式提取场景（主入口）
   */
  async extractIncremental(
    content: string,
    bookHash: string,
    chapterIndex: number,
    chapterTitle: string,
    continuityContext?: ContinuationContext | null,
  ): Promise<ExtractionResult> {
    console.log('[SceneExtractor] [extractIncremental] Starting extraction for:', chapterTitle);
    console.log('[SceneExtractor] [extractIncremental] Content length:', content.length);
    console.log(
      '[SceneExtractor] [extractIncremental] Continuity context from previous:',
      !!continuityContext,
    );

    const { scenes, lastContinuityContext } = await this.processChapter(
      content,
      bookHash,
      chapterIndex,
      chapterTitle,
      continuityContext,
    );

    console.log(
      '[SceneExtractor] [extractIncremental] ✓ Extraction complete:',
      scenes.length,
      'scenes extracted',
    );

    return {
      scenes,
      lastContinuityContext,
    };
  }
}
