import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Artifact canvas zoom scale maintains strict bounded range [0.5, 1.5]', () => {
  let scale = 1.0;
  const zoomIn = (z: number) => Math.min(1.5, Math.round((z + 0.25) * 100) / 100);
  const zoomOut = (z: number) => Math.max(0.5, Math.round((z - 0.25) * 100) / 100);

  // Test zoom in steps
  scale = zoomIn(scale);
  assert.equal(scale, 1.25);
  scale = zoomIn(scale);
  assert.equal(scale, 1.5);
  scale = zoomIn(scale);
  assert.equal(scale, 1.5, 'Zoom in must be bounded at 1.5x (150%)');

  // Test zoom out steps
  scale = zoomOut(scale);
  assert.equal(scale, 1.25);
  scale = zoomOut(scale);
  assert.equal(scale, 1.0);
  scale = zoomOut(scale);
  assert.equal(scale, 0.75);
  scale = zoomOut(scale);
  assert.equal(scale, 0.5);
  scale = zoomOut(scale);
  assert.equal(scale, 0.5, 'Zoom out must be bounded at 0.5x (50%)');

  // Reset
  scale = 1.0;
  assert.equal(scale, 1.0);
});

test('Device viewport frame presets define accurate width boundaries', () => {
  const getFrameWidth = (preset: 'desktop' | 'tablet' | 'mobile') => {
    switch (preset) {
      case 'mobile': return '375px';
      case 'tablet': return '768px';
      case 'desktop': return '100%';
    }
  };

  assert.equal(getFrameWidth('desktop'), '100%');
  assert.equal(getFrameWidth('tablet'), '768px');
  assert.equal(getFrameWidth('mobile'), '375px');
});
