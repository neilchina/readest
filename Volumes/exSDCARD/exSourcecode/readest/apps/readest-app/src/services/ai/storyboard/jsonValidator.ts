/**
 * JSON Validator for Scene Extraction
 * Handles malformed AI responses with proper brace tracking and string-aware parsing.
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  corrected?: { scenes: any };
}

const SCENE_SCHEMA = {
  properties: {
    scenes: { type: 'array' },
  },
};

function validateSchema(data: unknown): string[] {
  const errors: string[] = [];
  if (!data || typeof data !== 'object') {
    errors.push('JSON root must be an object');
    return errors;
  }
  const obj = data as Record<string, unknown>;

  // Support both old format (scenes array) and v3 format (scene_title + frames + optional fields)
  const hasOldFormat = Array.isArray(obj.scenes);
  const hasV3Format =
    typeof obj.scene_title === 'string' || typeof obj.frame1_description === 'string';

  if (!hasOldFormat && !hasV3Format) {
    errors.push(
      'Missing or invalid: expected "scenes" array or v3 scene fields (scene_title/frameN_description)',
    );
  }

  // If old format, validate each scene has required fields
  if (hasOldFormat) {
    for (let i = 0; i < (obj.scenes as any[]).length; i++) {
      const scene = (obj.scenes as any[])[i]!;
      if (!scene.id || !scene.sceneTitle || !Array.isArray(scene.frames)) {
        errors.push(`Scene at index ${i} missing required fields (id, sceneTitle, frames)`);
      }
    }
  }

  return errors;
}

/**
 * Clean JSON text: remove Markdown markers and find the JSON structure properly.
 * Uses a new dedicated brace tracking approach instead of normalizeJSONStructure.
 */
export function cleanJSONText(text: string): string {
  // Remove markdown code fences
  text = text.replace(/```json\s*/gi, '');
  text = text.replace(/```\s*/g, '');

  // Find the start of JSON structure (first [ or {)
  const arrayStartMatch = text.indexOf('[');
  const objectStartMatch = text.indexOf('{');

  let jsonStartMatch = -1;
  if (arrayStartMatch !== -1 && objectStartMatch !== -1) {
    jsonStartMatch = Math.min(arrayStartMatch, objectStartMatch);
  } else if (arrayStartMatch !== -1) {
    jsonStartMatch = arrayStartMatch;
  } else if (objectStartMatch !== -1) {
    jsonStartMatch = objectStartMatch;
  } else {
    return '';
  }

  text = text.slice(jsonStartMatch);

  // Determine whether we're tracking an array or object at root level
  const isArray = text.startsWith('[');
  // Track the matching end character for the root structure
  const targetEndChar = isArray ? ']' : '}';

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let endIndex = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '[' || char === '{') {
        depth++;
      } else if (char === ']' || char === '}') {
        depth--;
        if (depth === 0 && char === targetEndChar) {
          endIndex = i;
          break;
        }
      }
    }
  }

  if (endIndex !== -1) {
    text = text.slice(0, endIndex + 1);
  } else {
    return '';
  }

  return text.trim();
}

/**
 * Find matching bracket/brace end for a JSON string without normalizing.
 */
export function findMatchingEnd(text: string): number {
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '[' || char === '{') {
        depth++;
      } else if (char === ']' || char === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }

  return -1; // Not balanced
}

/**
 * Extract JSON from AI response with proper string-aware brace tracking.
 */
export function extractJSONFromResponse(response: string): string {
  const cleaned = cleanJSONText(response);
  if (!cleaned) return '';

  try {
    // First try direct parse
    JSON.parse(cleaned);
    return cleaned;
  } catch (parseError) {
    // Try to repair by finding balanced segments
    const repaired = repairAndExtract(cleaned);
    return repaired || cleaned;
  }
}

/**
 * Repair a malformed JSON string by fixing common issues.
 */
export function repairAndExtract(malformed: string): string {
  // First try: fix unescaped quotes inside values
  let repaired = tryFixUnescapedQuotes(malformed);
  if (repaired) return repaired;

  // Second try: just find the longest balanced prefix that starts with a valid structure
  const result = findLongestValidJSON(malformed);
  if (result) return result;

  return malformed; // Return as-is, let caller handle
}

/**
 * Try to fix unescaped quotes inside JSON values.
 */
export function tryFixUnescapedQuotes(text: string): string | null {
  const cleaned = cleanJSONText(text);
  if (!cleaned) return null;

  let result = '';
  let inString = false;
  let escapeNext = false;
  let depth = 0;
  let startIdx = -1; // When the root structure starts

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i]!;

    if (escapeNext) {
      escapeNext = false;
      result += char;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      result += char;
      continue;
    }

    if (char === '"') {
      // Check if this quote is inside a string value (depth > 0)
      if (!inString && depth > 0) {
        // This might be an unescaped quote - skip it and add escaped version
        result += '\\"';
        continue;
      }
      inString = !inString;
      result += char;
      continue;
    }

    if (!inString) {
      if (char === '[' || char === '{') {
        depth++;
      } else if (char === ']' || char === '}') {
        depth--;
        if (depth === 0 && i === cleaned.length - 1) {
          result += char;
          break; // End of balanced structure
        }
      }
    }

    result += char;
  }

  try {
    JSON.parse(result);
    return result;
  } catch {
    return null;
  }
}

/**
 * Find the longest valid JSON substring starting from a JSON structure.
 */
export function findLongestValidJSON(text: string): string | null {
  // Try different start positions and lengths to find balanced JSON
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;

    const endIdx = findMatchingEnd(text.slice(start));
    if (endIdx === -1) continue;

    let candidate = text.slice(start, start + endIdx + 1);

    // Try to parse directly first
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}

    // Try with quote fixing
    const fixed = tryFixUnescapedQuotes(candidate);
    if (fixed) return fixed;
  }

  return null;
}

/**
 * Validate and parse extracted JSON.
 */
export function validateAndParseJSON(
  jsonStr: string,
  options?: { strict?: boolean },
): ValidationResult {
  const errors: string[] = [];

  if (!jsonStr || !jsonStr.trim()) {
    return { valid: false, errors: ['Empty JSON response'] };
  }

  // Try parsing
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    const parseError = e as Error;
    errors.push(`JSON 解析失败：${parseError.message}`);

    if (options?.strict !== true) {
      // Attempt repair
      const repaired = repairAndExtract(jsonStr);
      if (repaired !== jsonStr) {
        try {
          parsed = JSON.parse(repaired);
          errors.push('尝试修复了 JSON 格式');
        } catch {
          return { valid: false, errors };
        }
      } else {
        return { valid: false, errors };
      }
    } else {
      return { valid: false, errors };
    }
  }

  // Validate schema
  if (parsed) {
    const schemaErrors = validateSchema(parsed);
    errors.push(...schemaErrors);
  }

  if (errors.length > 0 && !errors[0]!.includes('JSON')) {
    return { valid: false, errors };
  }

  // Check for corrected version
  let result: ValidationResult;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).scenes)) {
    const corrected = { scenes: (parsed as any).scenes.map((scene: any) => ({ ...scene })) };
    result = { valid: true, errors, corrected };
  } else if (parsed && typeof parsed === 'object') {
    // Wrap non-scene data
    const corrected = { scenes: [parsed] };
    result = { valid: true, errors, corrected };
  } else {
    return { valid: false, errors: ['JSON 格式不匹配场景提取结构'] };
  }

  return result;
}

/**
 * Main entry point: validate and parse AI scene extraction response.
 */
export function validateSceneExtractionResponse(response: string): ValidationResult {
  // Step 1: Extract JSON from the full AI response
  const extracted = extractJSONFromResponse(response);

  if (!extracted || !extracted.trim()) {
    return { valid: false, errors: ['无法从 AI 响应中提取有效 JSON'] };
  }

  console.log(
    '[validateAndParseJSON] Extracted JSON preview:',
    extracted.substring(0, 200) + '...',
  );

  // Step 2: Validate and parse the extracted JSON
  const result = validateAndParseJSON(extracted);

  if (result.valid) {
    console.log(
      `[validateAndParseJSON] Scene extraction format validated with ${result.corrected?.scenes.length ?? 0} scenes`,
    );
  } else {
    console.error('[validateAndParseJSON] Validation failed:', result.errors.join('; '));
  }

  return result;
}
