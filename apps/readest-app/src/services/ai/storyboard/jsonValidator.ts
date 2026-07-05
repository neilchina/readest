/**
 * JSON Validator for Storyboard Generator
 * 验证和修复 AI 生成的分镜 JSON
 */

import type { StoryboardJSON, ValidationResult } from './types';

/**
 * 从响应中提取 JSON 字符串
 */
export function extractJSONFromResponse(response: string): string | null {
  // 尝试提取 JSON 对象
  const objectMatch = response.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    return objectMatch[0];
  }

  // 尝试提取 JSON 数组
  const arrayMatch = response.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    return arrayMatch[0];
  }

  return null;
}

/**
 * 规范化 duration 值，确保总和等于目标值
 */
export function normalizeDurations(durations: string[], targetTotal: number = 12): string[] {
  const parsed = durations.map((d) => parseFloat(d.replace('s', '')));
  const currentTotal = parsed.reduce((sum, d) => sum + d, 0);

  if (currentTotal === 0 || Math.abs(currentTotal - targetTotal) < 0.1) {
    return durations;
  }

  const ratio = targetTotal / currentTotal;
  const normalized = parsed.map((d) => d * ratio);

  // 确保最后一个值补足差额
  const sumExceptLast = normalized.slice(0, -1).reduce((sum, d) => sum + d, 0);
  normalized[normalized.length - 1] = targetTotal - sumExceptLast;

  return normalized.map((d) => `${d.toFixed(1)}s`);
}

/**
 * 验证硬切描述是否完整
 */
export function validateHardCutDescriptions(shots: Array<{ content: string }>): string[] {
  const warnings: string[] = [];

  // Shot 1 应该有微动态描述
  if (shots[0]) {
    const hasMicroMotion = /(?:飘动 | 流动 | 起伏|摇曳 | 闪烁|波动)/.test(shots[0].content);
    if (!hasMicroMotion) {
      warnings.push('Shot 1: 缺少"镜头内持续微动态"描述（如：发丝飘动、衣物起伏、光影流动）');
    }
  }

  // Shot 2+ 应该有硬切描述
  for (let i = 1; i < shots.length; i++) {
    const hasHardCut = /(?:硬切|Hard Cut|直接切)/.test(shots[i]?.content || '');
    if (!hasHardCut) {
      warnings.push(`Shot ${i + 1}: 缺少硬切描述`);
    }
  }

  return warnings;
}

/**
 * 验证并解析 JSON
 */
export function validateAndParseJSON(jsonStr: string, _maxRetries?: number): ValidationResult {
  const errors: string[] = [];
  let cleanedJson = jsonStr;

  // 清理 Markdown 代码块
  cleanedJson = cleanedJson
    .replace(/```json\s*/g, '')
    .replace(/```\s*$/g, '')
    .trim();

  // 尝试解析 JSON
  let parsed: any;
  try {
    parsed = JSON.parse(cleanedJson);
  } catch (e) {
    errors.push(`JSON 解析失败：${(e as Error).message}`);
    return { valid: false, errors };
  }

  // 如果是数组，取第一个元素
  if (Array.isArray(parsed)) {
    parsed = parsed[0];
  }

  // 验证基本结构
  if (!parsed || typeof parsed !== 'object') {
    errors.push('JSON 结构无效');
    return { valid: false, errors };
  }

  // 检查 scene_list
  if (!parsed.scene_list || !Array.isArray(parsed.scene_list)) {
    errors.push('缺少 scene_list 数组');
    return { valid: false, errors };
  }

  if (parsed.scene_list.length === 0) {
    errors.push('scene_list 为空数组');
    return { valid: false, errors };
  }

  const scene = parsed.scene_list[0];

  // 检查 shot_list
  if (!scene.shot_list || !Array.isArray(scene.shot_list)) {
    errors.push('缺少 shot_list 数组');
    return { valid: false, errors };
  }

  if (scene.shot_list.length !== 4) {
    errors.push(`shot_list 必须有 4 个镜头，当前有 ${scene.shot_list.length} 个`);
  }

  // 验证每个镜头的必需字段
  const requiredFields = [
    'character_name',
    'character_appearance',
    'character_costume',
    'action_type',
    'motion_speed',
    'emotion',
    'shot_scale',
    'camera_angle',
    'shot_move',
    'shot_depth',
    'shot_pace',
    'shot_duration',
    'content',
  ];

  for (let i = 0; i < scene.shot_list.length; i++) {
    const shot = scene.shot_list[i];
    if (!shot) continue;

    for (const field of requiredFields) {
      if (!(field in shot)) {
        errors.push(`Shot ${i + 1}: 缺少 "${field}" 字段`);
      }
    }

    // 验证 duration 格式
    if (shot.shot_duration && typeof shot.shot_duration === 'string') {
      if (!/^\d+(\.\d+)?s$/.test(shot.shot_duration)) {
        errors.push(`Shot ${i + 1}: shot_duration 格式错误，应为 "3s" 格式`);
      }
    }

    // 验证 content 字段长度
    if (shot.content && typeof shot.content === 'string' && shot.content.length < 20) {
      errors.push(`Shot ${i + 1}: content 描述过短`);
    }
  }

  // 验证总时长
  if (parsed.parameters?.duration !== undefined) {
    const totalDuration = parsed.parameters.duration;
    if (Math.abs(totalDuration - 12) > 0.5) {
      errors.push(`总时长 ${totalDuration}s 不等于要求的 12 秒（允许误差±0.5 秒）`);
    }
  }

  // 验证硬切描述
  const hardCutWarnings = validateHardCutDescriptions(
    scene.shot_list.map((s: any) => ({ content: s.content || '' })),
  );
  errors.push(...hardCutWarnings);

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    corrected: parsed as StoryboardJSON,
  };
}

/**
 * 清理 JSON 字符串中的常见问题
 */
export function cleanJSON(jsonStr: string): string {
  let cleaned = jsonStr;

  // 移除 Markdown 代码块标记
  cleaned = cleaned.replace(/```json\s*/g, '');
  cleaned = cleaned.replace(/```\s*$/g, '');

  // 移除开头的非 JSON 文本
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  const startIdx = Math.min(
    firstBrace >= 0 ? firstBrace : Infinity,
    firstBracket >= 0 ? firstBracket : Infinity,
  );
  if (startIdx < Infinity) {
    cleaned = cleaned.slice(startIdx);
  }

  // 移除结尾的非 JSON 文本（保留最后一个 } 或 ]）
  const lastBrace = cleaned.lastIndexOf('}');
  const lastBracket = cleaned.lastIndexOf(']');
  const endIdx = Math.max(lastBrace >= 0 ? lastBrace : -1, lastBracket >= 0 ? lastBracket : -1);
  if (endIdx >= 0) {
    cleaned = cleaned.slice(0, endIdx + 1);
  }

  return cleaned.trim();
}
