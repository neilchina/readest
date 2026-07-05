# AI Storyboard Module - Change Log

## 📅 2026-07-05 | Version: v1.0.0 (AI Storyboard Feature)

### ✨ New Features

#### AI Storyboard Generator (分镜生成器)

- **功能描述**: 基于 AI 自动阅读整书并生成分镜剧本，将文字小说转换为电影级分镜脚本
- **核心模块**:
  - `StoryboardGenerator` - 主控制器，支持增量式分段提取
  - `SceneExtractor` - 场景提取器，逐段处理书籍内容
  - `storyboardStore` - IndexedDB 持久化存储层
  - `jsonValidator` - JSON 验证与自动修复

#### UI 集成

- **StoryboardPanel** - AI 分镜生成界面组件
- **NotebookTabNavigation** - 新增 Storyboard Tab（与 Notes、AI Chat 平级）
- **支持功能**:
  - 一键生成分镜
  - 进度实时显示
  - 导入/导出 JSON 格式
  - 本地存储管理

### 📝 Technical Details

#### Files Added

```
apps/readest-app/src/services/ai/storyboard/
├── index.ts                    # 模块入口
├── types.ts                    # 类型定义
├── prompts.ts                  # AI 提示词模板
├── jsonValidator.ts            # JSON 验证器
├── sceneExtractor.ts           # 场景提取器
├── storyboardGenerator.ts      # 分镜生成器
└── storyboardStore.ts          # 存储层

apps/readest-app/src/app/reader/components/notebook/
└── StoryboardPanel.tsx         # UI 组件
```

#### Files Modified

```
apps/readest-app/src/store/notebookStore.ts           # 添加 'storyboard' Tab 类型
apps/readest-app/src/app/reader/components/notebook/NotebookTabNavigation.tsx   # 新增 Storyboard 标签
apps/readest-app/src/app/reader/components/notebook/Notebook.tsx                # 移除子标签页导航
```

### 📌 Git Commits

| Commit Hash | Message                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `8d832afa`  | feat: restructure AI features as parallel tabs (AI Chat & Storyboard)      |
| `8ac5c5c2`  | feat: add detailed content logging in sceneExtractor for debugging         |
| `8a56942a`  | feat: add AI storyboard module for automatic book-to-storyboard generation |

### 🔧 Configuration Requirements

需要在 `.env.local` 或环境变量中配置：

```bash
# Ollama 配置
NEXT_PUBLIC_OLLAMA_BASE_URL=http://localhost:11434
NEXT_PUBLIC_OLLAMA_MODEL=qwen3-vl-nsfw:latest
NEXT_PUBLIC_OLLAMA_EMBEDDING_MODEL=bge-m3:latest
```

### 🚀 Usage

1. **启用 AI 功能**: 在设置中开启 Ollama 或 AI Gateway
2. **打开 Notebook**: 点击侧边栏的 Notebook 图标
3. **选择 Storyboard Tab**: 底部导航栏切换到 "Storyboard"
4. **生成分镜**: 点击 "开始生成分镜" 按钮

### 📊 Features Summary

| Feature                | Status | Description            |
| ---------------------- | ------ | ---------------------- |
| AI Chat                | ✅     | 与书籍内容对话         |
| Storyboard Generator   | ✅     | 自动生成分镜剧本       |
| Incremental Processing | ✅     | 支持大书分段处理       |
| Character Consistency  | ✅     | 跨场景保持角色一致性   |
| JSON Validation        | ✅     | 自动验证和修复 AI 输出 |
| Local Storage          | ✅     | IndexedDB 持久化存储   |
| Import/Export          | ✅     | JSON 格式导入导出      |

---

## 📋 Development Notes

### Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    Notebook UI                      │
├──────────┬──────────────┬──────────────────────────┤
│  Notes   │   AI Chat    │      Storyboard          │
└──────────┴──────────────┴──────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
  StoryboardPanel     StoryboardStore       StoryboardGenerator
         │                    │                    │
         └────────────────────┴────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
   SceneExtractor      JSON Validator        Prompts (System/User)
```

### Key Technologies

- **AI SDK**: 使用 `ai` package 进行流式文本生成
- **Zustand**: 状态管理（notebookStore）
- **IndexedDB**: 本地数据持久化（storyboardStore）
- **Ollama**: 本地 LLM 服务

---

_Generated: 2026-07-05_
_Repository: https://github.com/neilchina/readest_
