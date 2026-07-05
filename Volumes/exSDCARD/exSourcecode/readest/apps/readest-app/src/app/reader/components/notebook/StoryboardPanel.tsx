import React from 'react';
import type { BookScene, StoryboardJSON } from '@/services/ai/storyboard';

interface StoryboardPanelProps {
  scenes: BookScene[];
}

const StoryboardPanel: React.FC<StoryboardPanelProps> = ({ scenes }) => {
  return (
    <div className='p-4'>
      <h2 className='mb-4 text-xl font-bold'>Storyboard</h2>
      <div className='grid grid-cols-1 gap-4'>
        {scenes.map((scene, index) => (
          <div key={index} className='rounded-lg border p-3'>
            <h3 className='text-lg font-semibold'>{scene.sceneTitle}</h3>
            <p className='mt-1 text-sm text-gray-600'>{scene.actionPlot}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default StoryboardPanel;
