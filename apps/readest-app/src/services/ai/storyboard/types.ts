/**
 * Storyboard Generator Types
 * AI 自动阅读整书生成分镜剧本的数据类型定义
 */

// 分镜生成任务状态
export type StoryboardTaskStatus =
  | 'pending' // 等待开始
  | 'indexing' // 正在索引书籍
  | 'extracting' // 正在提取场景
  | 'generating' // 正在生成分镜
  | 'completed' // 已完成
  | 'paused' // 已暂停
  | 'error'; // 出错

// 分镜生成进度
export interface StoryboardProgress {
  phase: 'indexing' | 'extracting' | 'generating';
  current: number; // 当前处理到的章节/场景索引
  total: number; // 总章节/场景数
  completedScenes: number; // 已完成的分镜数量
  failedScenes: number; // 失败的场景数量
  errorMessage?: string;
}

// 单个分镜 JSON 结构
export interface StoryboardJSON {
  Name: string; // 分镜名称
  prompt: string; // 整体画风描述
  scene_list: Scene[]; // 场景列表
  parameters: StoryboardParameters; // 生成参数
}

// 场景定义
export interface Scene {
  scene_name: string; // 场景名称
  scene_type: '内景' | '外景'; // 内景/外景
  time_period: string; // 时间与天气
  env_attr: string; // 环境关键词
  space_attr: string; // 空间感关键词
  light_attr: string; // 光影关键词
  sound_attr: string; // 声音氛围关键词
  ambient_sound: string; // 环境音效
  shot_list: Shot[]; // 镜头列表（必须 4 个）
}

// 单个镜头定义
export interface Shot {
  character_name: string; // 角色名
  character_appearance: string; // 极详尽的角色外貌描述
  character_costume: string; // 极其详尽的服装材质、色彩与配饰描述
  action_type: string; // 动作类型
  motion_speed: '慢' | '正常' | '快'; // 运动速度
  emotion: string; // 情绪
  shot_scale: string; // 镜头尺度（特写/近景/中景等）
  camera_angle: string; // 相机角度
  shot_move: string; // 镜头移动方式
  shot_depth: '浅景深' | '正常景深' | '深景深'; // 景深
  shot_pace: '慢' | '正常' | '快'; // 节奏
  shot_duration: string; // 时长（如："3s"）
  content: string; // 详细画面描述（核心！必须包含硬切指令和微动态描述）
  vfx: string; // 视觉特效
  dialogue: string; // 台词
  sound_effect: string; // 特定动作音效
  foley_sound: string; // 拟音
}

// 生成参数
export interface StoryboardParameters {
  resolution: string; // "1920X1280"
  fps: number; // 帧率
  duration: number; // 总时长（秒）
  cfg_scale: number; // CFG 比例
  motion_bucket: number; // 运动桶值
  enhance_prompt: boolean; // 是否增强提示词
  audio_generation: boolean; // 是否生成音频
}

// 从书籍提取的场景数据
export interface BookScene {
  id: string; // 场景 ID
  bookHash: string; // 所属书籍
  chapterIndex: number; // 章节索引
  chapterTitle: string; // 章节标题
  sectionStart: number; // 在章节中的起始位置
  sectionEnd: number; // 在章节中的结束位置

  // 提取的内容（用于生成分镜）
  frame1_description: string; // 帧 1 描述
  frame2_description: string; // 帧 2 描述
  frame3_description: string; // 帧 3 描述
  frame4_description: string; // 帧 4 描述
  character_appearance: string; // 角色核心外貌、五官特征、长相、年龄、独特神态与体型细节
  costume_outfit: string; // 角色当前身穿的服装材质、色彩、配饰及破损/新旧程度描述
  action_plot: string; // 整体核心剧情动作线
  dialogues: string; // 原著台词及分配帧数说明
  audio_mood: string; // 环境音、配乐类型与整体电影氛围

  // 向后兼容字段（可选）
  character_info?: string; // 旧格式：角色身份与服装（可选，用于兼容）

  // 元数据
  wordCount: number; // 场景字数
  extractedAt: number; // 提取时间
}

// 分镜任务记录
export interface StoryboardTask {
  id: string; // 任务 ID
  bookHash: string; // 书籍哈希
  bookTitle: string; // 书籍标题
  status: StoryboardTaskStatus; // 状态
  progress: StoryboardProgress; // 进度

  createdAt: number; // 创建时间
  updatedAt: number; // 更新时间
  completedAt?: number; // 完成时间

  settings: AISettingsRef; // AI 设置引用
  totalScenes: number; // 总场景数
}

// AI 设置引用（避免存储完整配置）
export interface AISettingsRef {
  provider: 'ollama' | 'ai-gateway';
  model: string;
  embeddingModel: string;
}

// 生成分镜时的输入数据
export interface StoryboardInput {
  scene: BookScene; // 场景数据
  styleGuide?: StyleGuide; // 风格指南（可选）
}

// 视觉风格指南
export interface StyleGuide {
  visualStyle: string; // 视觉风格（如："赛博朋克"、"黑色电影"）
  colorPalette: string; // 色彩基调
  lightingStyle: string; // 灯光风格
  cameraStyle: string; // 摄影风格
  era: string; // 时代背景
}

// JSON 验证结果
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  corrected?: StoryboardJSON; // 如果自动修复成功，包含修复后的数据
}

// 多分镜响应格式（用户需要的格式）- 顶层是对象数组
export interface MultiStoryboardResponse {
  storyboard_list: StoryboardJSON[]; // 分镜列表数组
}

// 增量式提取的连续性上下文（用于跨片段保持角色一致性）
export interface ContinuationContext {
  characterAppearance: string; // 角色外貌描述
  costumeOutfit: string; // 服装描述
  lastSceneTitle: string; // 上一个场景标题
  plotSummary: string; // 剧情摘要
  lastFragmentEnd: number; // 上一片段结束位置
}

// 增量式提取结果
export interface ExtractionResult {
  scenes: BookScene[];
  lastContinuityContext: ContinuationContext | null;
}
