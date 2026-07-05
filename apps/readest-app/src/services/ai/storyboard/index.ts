/**
 * Storyboard Generator Module
 * AI 自动阅读整书生成分镜剧本的入口模块
 */

export { StoryboardGenerator } from './storyboardGenerator';
export { SceneExtractor, type SceneExtractorOptions } from './sceneExtractor';
export { storyboardStore } from './storyboardStore';

export type {
  StoryboardJSON,
  StoryboardProgress,
  StoryboardTask,
  StoryboardTaskStatus,
  BookScene,
  Scene,
  Shot,
  StoryboardParameters,
  ValidationResult,
  ContinuationContext,
  ExtractionResult,
} from './types';

export {
  STORYBOARD_SYSTEM_PROMPT,
  buildStoryboardUserPrompt,
  FRAGMENT_FRAME_EXTRACTION_SYSTEM_PROMPT,
  buildFragmentUserPrompt,
  SCENE_COMPOSITION_PROMPT,
  CHAPTER_PROCESSING_SYSTEM_PROMPT,
  JSON_REPAIR_PROMPT,
} from './prompts';

export { validateAndParseJSON, extractJSONFromResponse } from './jsonValidator';
