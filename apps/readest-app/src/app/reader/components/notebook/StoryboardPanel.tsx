'use client';

import { useState, useEffect, useRef } from 'react';
import { Play, Download, Upload, Trash2, Square, Pause, ChevronDown } from 'lucide-react';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { StoryboardGenerator, storyboardStore } from '@/services/ai/storyboard';
import type { StoryboardProgress, StoryboardJSON } from '@/services/ai/storyboard/types';
import { Button } from '@/components/ui/button';

const Card = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={`bg-card rounded-lg border ${className || ''}`}>{children}</div>
);
const CardContent = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => <div className={`p-6 pt-0 ${className || ''}`}>{children}</div>;
const CardHeader = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div className={`flex flex-col space-y-1.5 p-6 ${className || ''}`}>{children}</div>
);
const CardTitle = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <h3 className={`text-2xl font-semibold leading-none tracking-tight ${className || ''}`}>
    {children}
  </h3>
);

const Progress = ({ value, className }: { value: number; className?: string }) => (
  <div
    className={`bg-secondary relative h-4 w-full overflow-hidden rounded-full ${className || ''}`}
  >
    <div className='bg-primary h-full transition-all' style={{ width: `${value}%` }} />
  </div>
);

interface StoryboardPanelProps {
  bookKey: string;
}

export interface BookSegment {
  index: number;
  content: string;
}

interface SystemPromptHistory {
  id: string;
  name: string;
  content: string;
  createdAt: number;
}

const STORAGE_KEY = 'storyboard_system_prompts';

export const StoryboardPanel: React.FC<StoryboardPanelProps> = ({ bookKey }) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState<StoryboardProgress | null>(null);
  const [storyboards, setStoryboards] = useState<StoryboardJSON[]>([]);
  const [segments, setSegments] = useState<BookSegment[]>([]);
  const generatorRef = useRef<StoryboardGenerator | null>(null);

  // 自定义系统提示词相关状态
  const [customSystemPrompt, setCustomSystemPrompt] = useState<string>('');
  const [selectedPromptId, setSelectedPromptId] = useState<string>('');
  const [promptHistory, setPromptHistory] = useState<SystemPromptHistory[]>([]);
  const [isPromptDropdownOpen, setIsPromptDropdownOpen] = useState(false);
  const promptDropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (promptDropdownRef.current && !promptDropdownRef.current.contains(event.target as Node)) {
        setIsPromptDropdownOpen(false);
      }
    };
    if (isPromptDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isPromptDropdownOpen]);

  const { getBookData } = useBookDataStore();
  const { settings } = useSettingsStore();

  const bookData = getBookData(bookKey);
  const bookHash = bookKey.split('-')[0] || '';
  const bookTitle = bookData?.book?.title || 'Unknown Book';

  // 加载历史记录（从 localStorage）
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        try {
          const prompts: SystemPromptHistory[] = JSON.parse(saved);
          setPromptHistory(prompts);
        } catch (e) {
          console.error('Failed to parse prompt history:', e);
        }
      }
    }
  }, []);

  // 加载已保存的分镜数据
  useEffect(() => {
    if (bookHash) {
      loadStoryboards();
      loadTasks();
    }
  }, [bookHash]);

  const loadStoryboards = async () => {
    try {
      const data = await storyboardStore.getStoryboards(bookHash);
      setStoryboards(data);
    } catch (error) {
      console.error('Failed to load storyboards:', error);
    }
  };

  const loadTasks = async () => {
    try {
      await storyboardStore.getTasks(bookHash);
    } catch (error) {
      console.error('Failed to load tasks:', error);
    }
  };

  // 保存提示词到 localStorage
  const saveToStorage = (prompts: SystemPromptHistory[]) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
    }
  };

  // 保存当前提示词
  const saveCurrentPrompt = () => {
    const name = prompt('请输入提示词名称：');
    if (!name || !customSystemPrompt.trim()) return;

    const newPrompt: SystemPromptHistory = {
      id: Date.now().toString(),
      name,
      content: customSystemPrompt,
      createdAt: Date.now(),
    };

    const updated = [newPrompt, ...promptHistory].slice(0, 20); // 最多保存 20 条
    setPromptHistory(updated);
    saveToStorage(updated);
    alert('提示词已保存');
  };

  // 加载选中的提示词
  const loadPrompt = (id: string) => {
    setSelectedPromptId(id);
    if (!id) {
      return;
    }
    const item = promptHistory.find((p) => p.id === id);
    if (item) {
      setCustomSystemPrompt(item.content);
    }
  };

  // 清空提示词
  const clearPrompt = () => {
    setCustomSystemPrompt('');
    setSelectedPromptId('');
  };

  const handleGenerate = async () => {
    if (!bookData?.bookDoc || !settings.aiSettings.enabled) return;

    setIsGenerating(true);
    setIsPaused(false);
    setProgress({
      phase: 'extracting',
      current: 0,
      total: bookData.bookDoc.sections?.length || 1,
      completedScenes: 0,
      failedScenes: 0,
    });

    try {
      // Step 1: Split content into segments and display them
      const generator = new StoryboardGenerator(settings.aiSettings);
      generatorRef.current = generator;

      // Get segments for display
      const segmentSize = 3000;
      const rawSegments = await (generator as any).splitContentBySize(
        bookData.bookDoc,
        segmentSize,
      );
      const newSegments: BookSegment[] = rawSegments.map((s: { content: string }, idx: number) => ({
        index: idx,
        content: s.content,
      }));
      setSegments(newSegments);

      // Step 2: Generate storyboards using the segments (user can edit before this)
      const results = await generator.generateFromBook(
        bookData.bookDoc,
        bookHash,
        bookTitle,
        (p: StoryboardProgress) => {
          setProgress(p);
        },
        customSystemPrompt || undefined, // 传递自定义提示词
      );

      // 保存生成的分镜数据
      const storyboardsWithMeta = results.map((sb: StoryboardJSON, idx: number) => ({
        ...sb,
        id: `${bookHash}-storyboard-${Date.now()}-${idx}`,
        bookHash,
        createdAt: Date.now(),
      }));

      await storyboardStore.saveStoryboards(storyboardsWithMeta);
      setStoryboards((prev) => [...prev, ...results]);
    } catch (error) {
      console.error('Storyboard generation failed:', error);
      const errorMessage = (error as Error).message;
      setProgress((prev) =>
        prev
          ? {
              ...prev,
              errorMessage: errorMessage,
            }
          : null,
      );
    } finally {
      setIsGenerating(false);
      setIsPaused(false);
      generatorRef.current = null;
    }
  };

  const handleSegmentChange = (index: number, newContent: string) => {
    setSegments((prev) =>
      prev.map((seg) => (seg.index === index ? { ...seg, content: newContent } : seg)),
    );
  };

  const handlePause = () => {
    if (generatorRef.current) {
      generatorRef.current.cancel();
      setIsPaused(true);
      setIsGenerating(false);
    }
  };

  const handleStop = () => {
    if (generatorRef.current) {
      generatorRef.current.cancel();
      generatorRef.current = null;
    }
    setIsGenerating(false);
    setIsPaused(false);
    setProgress((prev) =>
      prev
        ? {
            ...prev,
            errorMessage: 'Generation stopped by user',
          }
        : null,
    );
  };

  const handleClear = async () => {
    if (!bookHash) return;

    if (!window.confirm('确定要删除所有分镜数据吗？此操作不可恢复。')) return;
    await storyboardStore.deleteStoryboards(bookHash);
    setStoryboards([]);
  };

  const handleExport = async () => {
    try {
      const jsonStr = await storyboardStore.exportToJSON(bookHash);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${bookTitle.replace(/[^a-zA-Z0-9]/g, '_')}_storyboards.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Export failed:', error);
    }
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !bookHash) return;

    try {
      const text = await file.text();
      const count = await storyboardStore.importFromJSON(text, bookHash);
      await loadStoryboards();
      window.alert(`成功导入 ${count} 个分镜`);
    } catch (error) {
      console.error('Import failed:', error);
      window.alert('导入失败：无效的 JSON 格式');
    } finally {
      event.target.value = '';
    }
  };

  const progressPercent = progress
    ? Math.round((progress.completedScenes / (progress.total || 1)) * 100)
    : 0;

  return (
    <div className='flex h-full flex-col space-y-4 p-4'>
      {/* 标题 */}
      <div>
        <h2 className='text-lg font-semibold'>AI 分镜生成器</h2>
      </div>

      {/* 操作栏 */}
      <div className='flex gap-2'>
        {isGenerating ? (
          <>
            <Button size='sm' onClick={handlePause} disabled={!isGenerating || isPaused}>
              <Pause className='mr-1 h-4 w-4' />
              暂停
            </Button>
            <Button variant='destructive' size='sm' onClick={handleStop}>
              <Square className='mr-1 h-4 w-4' />
              停止
            </Button>
          </>
        ) : (
          <div className='relative' ref={promptDropdownRef}>
            <Button size='sm' onClick={() => setIsPromptDropdownOpen(!isPromptDropdownOpen)}>
              {customSystemPrompt ? '自定义提示词 ▼' : '开始生成分镜 ▼'}
              <ChevronDown
                className={`ml-1 h-4 w-4 transition-transform ${isPromptDropdownOpen ? 'rotate-180' : ''}`}
              />
            </Button>

            {/* 下拉菜单内容 */}
            {isPromptDropdownOpen && (
              <div className='bg-base-100 absolute left-0 top-full z-50 mt-2 w-96 rounded-lg border shadow-lg'>
                <div className='p-4'>
                  {/* 历史记录选择区 */}
                  <div className='mb-3'>
                    <div className='mb-2 flex items-center justify-between'>
                      <span className='text-xs font-medium text-gray-600'>历史提示词</span>
                      <Button size='sm' onClick={saveCurrentPrompt}>
                        保存当前
                      </Button>
                    </div>
                    <select
                      value={selectedPromptId}
                      onChange={(e) => loadPrompt(e.target.value)}
                      className='bg-base-100 w-full rounded border p-1 text-sm'
                    >
                      <option value=''>自定义输入...</option>
                      {promptHistory.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* 编辑区 */}
                  <textarea
                    value={customSystemPrompt}
                    onChange={(e) => setCustomSystemPrompt(e.target.value)}
                    placeholder='输入自定义规则提示词（留空则使用默认）...'
                    className='bg-base-100 focus:border-primary h-40 w-full resize-none rounded border p-2 text-sm focus:outline-none'
                  />

                  {/* 操作按钮 */}
                  <div className='mt-3 flex justify-between gap-2'>
                    <Button variant='outline' size='sm' onClick={clearPrompt}>
                      清空
                    </Button>
                    <Button
                      size='sm'
                      onClick={() => {
                        setIsPromptDropdownOpen(false);
                        handleGenerate();
                      }}
                    >
                      开始生成
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <Button
          variant='outline'
          size='sm'
          onClick={handleClear}
          disabled={storyboards.length === 0 || isGenerating}
          className='text-error'
        >
          <Trash2 className='mr-1 h-4 w-4' />
          清除
        </Button>

        <Button
          variant='outline'
          size='sm'
          onClick={handleExport}
          disabled={storyboards.length === 0 || isGenerating}
        >
          <Download className='mr-1 h-4 w-4' />
          导出
        </Button>

        <label>
          <input type='file' accept='.json' onChange={handleImport} className='hidden' />
          <Button variant='outline' size='sm' asChild disabled={isGenerating}>
            <span>
              <Upload className='mr-1 h-4 w-4' />
              导入
            </span>
          </Button>
        </label>
      </div>

      {/* AI 设置提示 */}
      {!settings.aiSettings.enabled && (
        <Card className='border-yellow-200 bg-yellow-50'>
          <CardContent className='p-4'>
            <p className='text-sm text-yellow-800'>
              ⚠️ 请先在设置中启用 AI 功能（Ollama 或 AI Gateway）
            </p>
          </CardContent>
        </Card>
      )}

      {/* 进度显示 */}
      {progress && (
        <Card>
          <CardHeader className='pb-2'>
            <div className='flex items-center justify-between'>
              <CardTitle className='text-sm font-medium'>生成进度</CardTitle>
              <span className='text-xs text-gray-500'>
                {isPaused ? (
                  <span className='text-yellow-600'>已暂停</span>
                ) : progress.phase === 'extracting' ? (
                  '提取场景'
                ) : (
                  '生成分镜'
                )}{' '}
                | 完成：{progress.completedScenes}/{progress.current}/{progress.total}
                {progress.failedScenes > 0 && (
                  <span className='text-error ml-2'>失败：{progress.failedScenes}</span>
                )}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            <Progress value={progressPercent} className='h-2' />
            {progress.errorMessage && (
              <p className='text-error mt-2 text-xs'>{progress.errorMessage}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* 书籍分段内容编辑区 */}
      {segments.length > 0 && (
        <Card>
          <CardHeader className='pb-2'>
            <div className='flex items-center justify-between'>
              <CardTitle className='text-sm font-medium'>书籍分段内容</CardTitle>
              <span className='text-xs text-gray-500'>共 {segments.length} 段</span>
            </div>
          </CardHeader>
          <CardContent>
            <div className='max-h-96 space-y-3 overflow-y-auto pr-2'>
              {segments.map((segment) => (
                <div key={segment.index} className='rounded border bg-gray-50 p-3'>
                  <div className='mb-2 flex items-center justify-between'>
                    <span className='text-xs font-medium text-gray-600'>
                      分段 {segment.index + 1}
                    </span>
                    <span className='text-xs text-gray-400'>{segment.content.length} 字符</span>
                  </div>
                  <textarea
                    value={segment.content}
                    onChange={(e) => handleSegmentChange(segment.index, e.target.value)}
                    className='focus:border-primary h-24 w-full resize-none rounded border bg-white p-2 text-sm focus:outline-none'
                    placeholder='分段内容...'
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 分镜列表 */}
      <div className='flex-1 space-y-3 overflow-y-auto'>
        {storyboards.length === 0 ? (
          <Card className='py-8 text-center'>
            <CardContent className='flex flex-col items-center'>
              <div className='mb-4 rounded-full bg-gray-100 p-4'>
                <Play className='h-8 w-8 text-gray-400' />
              </div>
              <p className='text-sm text-gray-500'>暂无分镜数据</p>
              <p className='mt-1 text-xs text-gray-400'>点击"开始生成分镜"创建第一个分镜</p>
            </CardContent>
          </Card>
        ) : (
          storyboards.map((sb: StoryboardJSON, idx: number) => (
            <StoryboardItem key={idx} storyboard={sb} index={idx + 1} />
          ))
        )}
      </div>

      {/* 统计信息 */}
      {storyboards.length > 0 && (
        <Card className='bg-gray-50'>
          <CardContent className='p-3'>
            <div className='flex justify-between text-xs text-gray-600'>
              <span>总分镜数：{storyboards.length}</span>
              {progress && isGenerating && <span className='text-primary'>正在生成中...</span>}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

// 单个分镜组件
const StoryboardItem: React.FC<{ storyboard: StoryboardJSON; index: number }> = ({
  storyboard,
  index,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <Card className='cursor-pointer transition-colors hover:bg-gray-50'>
      <div className='p-4' onClick={() => setIsExpanded(!isExpanded)}>
        <div className='flex items-center justify-between'>
          <div>
            <h3 className='text-sm font-medium'>{storyboard.Name || `分镜 ${index}`}</h3>
            <p className='mt-1 text-xs text-gray-500'>
              {storyboard.scene_list?.length || 0} 个场景 | 总时长：
              {storyboard.parameters?.duration || 0}s
            </p>
          </div>
          <span className={`transform transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
            ▶
          </span>
        </div>

        {isExpanded && (
          <div className='mt-4 space-y-3 border-t pt-4'>
            {/* 总提示词 */}
            <div>
              <p className='mb-1 text-xs font-medium text-gray-500'>整体画风</p>
              <p className='text-sm'>{storyboard.prompt}</p>
            </div>

            {/* 场景列表 */}
            {storyboard.scene_list?.map((scene, sceneIdx) => (
              <div key={sceneIdx} className='rounded bg-gray-50 p-3'>
                <p className='mb-2 text-xs font-medium text-gray-700'>
                  场景 {sceneIdx + 1}: {scene.scene_name} ({scene.scene_type})
                </p>

                {/* 镜头列表 */}
                <div className='space-y-2'>
                  {scene.shot_list?.map((shot, shotIdx) => (
                    <div key={shotIdx} className='rounded bg-white p-2 text-xs'>
                      <div className='mb-1 flex justify-between'>
                        <span className='font-medium'>镜头 {shotIdx + 1}</span>
                        <span className='text-gray-500'>{shot.shot_duration}</span>
                      </div>
                      <p className='mb-1 text-gray-700'>{shot.content}</p>
                      {shot.dialogue && shot.dialogue !== '无' && (
                        <p className='text-primary italic'>"{shot.dialogue}"</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* 参数 */}
            <div className='rounded bg-gray-100 p-2 text-xs'>
              <p>
                <strong>分辨率:</strong> {storyboard.parameters?.resolution}
              </p>
              <p>
                <strong>FPS:</strong> {storyboard.parameters?.fps}
              </p>
              <p>
                <strong>CFG Scale:</strong> {storyboard.parameters?.cfg_scale}
              </p>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
};

export default StoryboardPanel;
