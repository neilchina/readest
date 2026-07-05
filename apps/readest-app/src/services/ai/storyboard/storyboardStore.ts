/**
 * Storyboard Store
 * IndexedDB 持久化存储分镜数据和任务进度
 */

import type { StoryboardJSON, StoryboardTask, StoryboardProgress, BookScene } from './types';

// 扩展类型用于存储（添加 id、bookHash 和 createdAt）
export interface StoryboardWithMeta extends StoryboardJSON {
  id: string;
  bookHash: string;
  createdAt?: number;
  updatedAt?: number;
}

const DB_NAME = 'readest-storyboard';
const DB_VERSION = 1;
const STORYBOARDS_STORE = 'storyboards';
const TASKS_STORE = 'tasks';
const SCENES_STORE = 'scenes';

/**
 * Storyboard Store 类
 */
export class StoryboardStore {
  private db: IDBDatabase | null = null;

  /**
   * 打开数据库
   */
  private async openDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('[StoryboardStore] Failed to open database:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;

        // 创建 storyboards 存储区
        if (!db.objectStoreNames.contains(STORYBOARDS_STORE)) {
          const store = db.createObjectStore(STORYBOARDS_STORE, { keyPath: 'id' });
          store.createIndex('bookHash', 'bookHash', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }

        // 创建 tasks 存储区
        if (!db.objectStoreNames.contains(TASKS_STORE)) {
          const store = db.createObjectStore(TASKS_STORE, { keyPath: 'id' });
          store.createIndex('bookHash', 'bookHash', { unique: false });
          store.createIndex('status', 'status', { unique: false });
        }

        // 创建 scenes 存储区
        if (!db.objectStoreNames.contains(SCENES_STORE)) {
          const store = db.createObjectStore(SCENES_STORE, { keyPath: 'id' });
          store.createIndex('bookHash', 'bookHash', { unique: false });
          store.createIndex('chapterIndex', 'chapterIndex', { unique: false });
        }

        // 版本迁移逻辑（未来扩展）
        if (oldVersion < 1) {
          console.log('[StoryboardStore] Database initialized');
        }
      };
    });
  }

  /**
   * 保存分镜数据
   */
  async saveStoryboard(storyboard: StoryboardWithMeta): Promise<void> {
    const db = await this.openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORYBOARDS_STORE, 'readwrite');
      const store = tx.objectStore(STORYBOARDS_STORE);

      const data = {
        ...storyboard,
        updatedAt: Date.now(),
      };

      store.put(data);

      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.error('[StoryboardStore] saveStoryboard error:', tx.error);
        reject(tx.error);
      };
    });
  }

  /**
   * 保存多个分镜数据
   */
  async saveStoryboards(storyboards: StoryboardWithMeta[]): Promise<void> {
    const db = await this.openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORYBOARDS_STORE, 'readwrite');
      const store = tx.objectStore(STORYBOARDS_STORE);

      for (const storyboard of storyboards) {
        store.put({ ...storyboard, updatedAt: Date.now() });
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.error('[StoryboardStore] saveStoryboards error:', tx.error);
        reject(tx.error);
      };
    });
  }

  /**
   * 获取书籍的所有分镜数据
   */
  async getStoryboards(bookHash: string): Promise<StoryboardWithMeta[]> {
    const db = await this.openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORYBOARDS_STORE, 'readonly');
      const store = tx.objectStore(STORYBOARDS_STORE);
      const index = store.index('bookHash');

      const request = index.getAll(bookHash);

      request.onsuccess = () => {
        const results = (request.result || []) as StoryboardWithMeta[];
        resolve(results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
      };

      request.onerror = () => {
        console.error('[StoryboardStore] getStoryboards error:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * 获取单个分镜数据
   */
  async getStoryboard(id: string): Promise<StoryboardJSON | null> {
    const db = await this.openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORYBOARDS_STORE, 'readonly');
      const store = tx.objectStore(STORYBOARDS_STORE);
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 删除书籍的所有分镜数据
   */
  async deleteStoryboards(bookHash: string): Promise<void> {
    const db = await this.openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORYBOARDS_STORE, 'readwrite');
      const store = tx.objectStore(STORYBOARDS_STORE);
      const index = store.index('bookHash');

      const request = index.getAllKeys(bookHash);

      request.onsuccess = () => {
        const keys = request.result || [];
        for (const key of keys) {
          store.delete(key);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * 创建任务记录
   */
  async createTask(task: Omit<StoryboardTask, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
    const db = await this.openDB();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(TASKS_STORE, 'readwrite');
      const store = tx.objectStore(TASKS_STORE);

      const data: StoryboardTask = {
        ...task,
        id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      store.put(data);

      tx.oncomplete = () => resolve(id);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * 更新任务进度
   */
  async updateTaskProgress(taskId: string, progress: StoryboardProgress): Promise<void> {
    const db = await this.openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(TASKS_STORE, 'readwrite');
      const store = tx.objectStore(TASKS_STORE);
      const request = store.get(taskId);

      request.onsuccess = () => {
        const task = request.result as StoryboardTask | undefined;
        if (task) {
          task.progress = progress;
          task.updatedAt = Date.now();
          store.put(task);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * 完成任务任务
   */
  async completeTask(taskId: string): Promise<void> {
    const db = await this.openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(TASKS_STORE, 'readwrite');
      const store = tx.objectStore(TASKS_STORE);
      const request = store.get(taskId);

      request.onsuccess = () => {
        const task = request.result as StoryboardTask | undefined;
        if (task) {
          task.status = 'completed';
          task.completedAt = Date.now();
          task.updatedAt = Date.now();
          store.put(task);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * 获取任务记录
   */
  async getTask(taskId: string): Promise<StoryboardTask | null> {
    const db = await this.openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(TASKS_STORE, 'readonly');
      const store = tx.objectStore(TASKS_STORE);
      const request = store.get(taskId);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 获取书籍的所有任务
   */
  async getTasks(bookHash: string): Promise<StoryboardTask[]> {
    const db = await this.openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(TASKS_STORE, 'readonly');
      const store = tx.objectStore(TASKS_STORE);
      const index = store.index('bookHash');

      const request = index.getAll(bookHash);

      request.onsuccess = () => {
        const results = request.result || [];
        resolve(results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 保存场景数据（用于断点续传）
   */
  async saveScene(scene: BookScene): Promise<void> {
    const db = await this.openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(SCENES_STORE, 'readwrite');
      const store = tx.objectStore(SCENES_STORE);

      store.put(scene);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * 获取书籍的所有场景
   */
  async getScenes(bookHash: string): Promise<BookScene[]> {
    const db = await this.openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(SCENES_STORE, 'readonly');
      const store = tx.objectStore(SCENES_STORE);
      const index = store.index('bookHash');

      const request = index.getAll(bookHash);

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * 删除书籍的所有场景数据
   */
  async deleteScenes(bookHash: string): Promise<void> {
    const db = await this.openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(SCENES_STORE, 'readwrite');
      const store = tx.objectStore(SCENES_STORE);
      const index = store.index('bookHash');

      const request = index.getAllKeys(bookHash);

      request.onsuccess = () => {
        const keys = request.result || [];
        for (const key of keys) {
          store.delete(key);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * 导出分镜数据为 JSON 文件
   */
  async exportToJSON(bookHash: string): Promise<string> {
    const storyboards = await this.getStoryboards(bookHash);
    return JSON.stringify(storyboards, null, 2);
  }

  /**
   * 从 JSON 导入分镜数据
   */
  async importFromJSON(jsonString: string, bookHash: string): Promise<number> {
    try {
      const storyboards = JSON.parse(jsonString) as StoryboardWithMeta[];
      const imported: StoryboardWithMeta[] = [];

      for (const sb of storyboards) {
        imported.push({
          ...sb,
          id: sb.id || `${bookHash}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          bookHash,
          createdAt: sb.createdAt || Date.now(),
        });
      }

      await this.saveStoryboards(imported);
      return imported.length;
    } catch (error) {
      console.error('[StoryboardStore] Import failed:', error);
      throw new Error('Invalid JSON format');
    }
  }
}

// 导出单例实例
export const storyboardStore = new StoryboardStore();
