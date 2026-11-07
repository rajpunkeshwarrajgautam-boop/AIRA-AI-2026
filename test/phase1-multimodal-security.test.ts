import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MultiModalAssetViewer } from '../src/components/MultiModalAssetViewer';
import {
  normalizeAndValidateArtifactPath,
  inferArtifactFileKind,
  ArtifactPathSecurityError
} from '../src/utils/artifactPathSecurity';
import { sanitizeSvgMarkup, formatAudioTime } from '../src/utils/multiModalAssets';
import {
  createMultiFileBundle,
  adaptSingleFileArtifactToBundle
} from '../src/utils/artifactBundleEngine';
import { generateProjectZipArchive } from '../src/utils/artifactZipExporter';
import type { Artifact } from '../src/types';

describe('Phase 1: Multi-Modal Assets & Cross-Phase Security Hardening', () => {
  it('sanitizes SVG markup by removing scripts, event handlers, and javascript URIs', () => {
    const maliciousSvg = `
      <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <script>alert("xss")</script>
        <circle cx="50" cy="50" r="40" fill="teal" onload="fetch('/leak')" onclick="hack()" />
        <a href="javascript:alert(1)">
          <text x="10" y="20">Click me</text>
        </a>
        <a xlink:href="javascript:void(0)">
          <text x="10" y="40">Click me 2</text>
        </a>
        <foreignObject width="100" height="50">
          <body xmlns="http://www.w3.org/1999/xhtml">
            <iframe src="evil.com"></iframe>
          </body>
        </foreignObject>
      </svg>
    `;

    const sanitized = sanitizeSvgMarkup(maliciousSvg);

    assert.ok(!sanitized.includes('<script>'), 'script tag must be removed');
    assert.ok(!sanitized.includes('alert("xss")'), 'script content must be removed');
    assert.ok(!sanitized.includes('<foreignObject'), 'foreignObject must be removed');
    assert.ok(!sanitized.includes('onload='), 'onload attribute must be stripped');
    assert.ok(!sanitized.includes('onclick='), 'onclick attribute must be stripped');
    assert.ok(!sanitized.includes('javascript:'), 'javascript URIs must be replaced with #');
    assert.ok(sanitized.includes('<circle cx="50" cy="50" r="40" fill="teal"'), 'valid SVG shapes preserved');
    assert.ok(sanitized.includes('Click me'), 'text elements preserved');
  });

  it('renders untrusted SVG only as an inert image, never executable parent DOM', () => {
    const html = renderToStaticMarkup(createElement(MultiModalAssetViewer, {
      file: {
        id: 'svg_bad',
        path: 'assets/untrusted.svg',
        name: 'untrusted.svg',
        content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle onload="evil()"/></svg>',
        kind: 'svg',
        sizeBytes: 104,
        lastModified: 1,
        version: 1,
      }
    }));
    assert.match(html, /data-testid="svg-inert-image"/);
    assert.match(html, /src="data:image\/svg\+xml;charset=utf-8,/);
    // Toolbar icons are themselves trusted SVG elements; the artifact markup
    // must remain confined to the encoded image URL.
    assert.doesNotMatch(html, /<script\b|onload="evil\(\)"|alert\(1\)/);
  });

  it('rejects control characters even when whitespace surrounds the path', () => {
    for (const path of ['\timages/logo.svg', 'images/logo.svg\n', 'images/\0logo.svg']) {
      assert.throws(() => normalizeAndValidateArtifactPath(path), ArtifactPathSecurityError);
    }
  });

  it('rejects Windows reserved device names in artifact paths', () => {
    const reservedNames = ['con.txt', 'prn.log', 'aux.json', 'nul.svg', 'com1.ts', 'lpt9.html'];

    for (const name of reservedNames) {
      assert.throws(
        () => normalizeAndValidateArtifactPath(name),
        (err: unknown) => {
          assert.ok(err instanceof ArtifactPathSecurityError);
          assert.match((err as Error).message, /Windows reserved device name/i);
          return true;
        },
        `Expected ${name} to be rejected as Windows reserved name`
      );

      // Also nested path e.g. "assets/nul.json"
      assert.throws(
        () => normalizeAndValidateArtifactPath(`assets/${name}`),
        (err: unknown) => {
          assert.ok(err instanceof ArtifactPathSecurityError);
          assert.match((err as Error).message, /Windows reserved device name/i);
          return true;
        }
      );
    }

    // Safe names containing substrings of reserved words must still pass
    assert.equal(normalizeAndValidateArtifactPath('constants.ts'), 'constants.ts');
    assert.equal(normalizeAndValidateArtifactPath('components/controller.tsx'), 'components/controller.tsx');
    assert.equal(normalizeAndValidateArtifactPath('auxiliary.css'), 'auxiliary.css');
  });

  it('accurately classifies multi-modal file extensions into ArtifactFileKind', () => {
    assert.equal(inferArtifactFileKind('assets/logo.png'), 'image');
    assert.equal(inferArtifactFileKind('assets/photo.jpg'), 'image');
    assert.equal(inferArtifactFileKind('assets/photo.jpeg'), 'image');
    assert.equal(inferArtifactFileKind('assets/hero.webp'), 'image');
    assert.equal(inferArtifactFileKind('assets/spinner.gif'), 'image');
    assert.equal(inferArtifactFileKind('assets/diagram.svg'), 'svg');
    assert.equal(inferArtifactFileKind('audio/bell.mp3'), 'audio');
    assert.equal(inferArtifactFileKind('audio/click.wav'), 'audio');
    assert.equal(inferArtifactFileKind('audio/ambience.ogg'), 'audio');
    assert.equal(inferArtifactFileKind('video/screencast.mp4'), 'video');
    assert.equal(inferArtifactFileKind('video/preview.webm'), 'video');
    assert.equal(inferArtifactFileKind('docs/specification.pdf'), 'pdf');
    assert.equal(inferArtifactFileKind('index.html'), 'html');
    assert.equal(inferArtifactFileKind('src/App.tsx'), 'typescript');
  });

  it('creates multi-modal bundles and adapts single-file multi-modal artifacts', () => {
    const rawBundle = createMultiFileBundle({
      id: 'bundle_multimodal',
      title: 'Design System Media Kit',
      files: [
        { path: 'index.html', content: '<h1>Media Kit</h1>', isEntry: true },
        { path: 'assets/logo.svg', content: '<svg><circle r="10"/></svg>' },
        { path: 'assets/hero.png', content: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
        { path: 'audio/chime.mp3', content: 'audio-binary-payload' }
      ]
    });

    assert.equal(rawBundle.files['assets/logo.svg']?.kind, 'svg');
    assert.equal(rawBundle.files['assets/hero.png']?.kind, 'image');
    assert.equal(rawBundle.files['audio/chime.mp3']?.kind, 'audio');
    assert.equal(rawBundle.manifest.files.length, 4);

    // Single-file artifact adaptation
    const imageArtifact: Artifact = {
      id: 'art_img',
      title: 'Generated Poster',
      type: 'image/png',
      content: 'data:image/png;base64,mock',
      version: 1,
      versions: [{ version: 1, content: 'data:image/png;base64,mock', timestamp: Date.now() }]
    };

    const adaptedImg = adaptSingleFileArtifactToBundle(imageArtifact);
    assert.equal(adaptedImg.entryPoint, 'image.png');
    assert.equal(adaptedImg.files['image.png']?.kind, 'image');

    const audioArtifact: Artifact = {
      id: 'art_audio',
      title: 'Voice Narration',
      type: 'audio/mpeg',
      content: 'audio-data',
      version: 1,
      versions: [{ version: 1, content: 'audio-data', timestamp: Date.now() }]
    };

    const adaptedAudio = adaptSingleFileArtifactToBundle(audioArtifact);
    assert.equal(adaptedAudio.entryPoint, 'audio.mp3');
    assert.equal(adaptedAudio.files['audio.mp3']?.kind, 'audio');

    const pdfArtifact: Artifact = {
      id: 'art_pdf',
      title: 'Architectural Spec',
      type: 'application/pdf',
      content: 'pdf-stream-data',
      version: 1,
      versions: [{ version: 1, content: 'pdf-stream-data', timestamp: Date.now() }]
    };

    const adaptedPdf = adaptSingleFileArtifactToBundle(pdfArtifact);
    assert.equal(adaptedPdf.entryPoint, 'document.pdf');
    assert.equal(adaptedPdf.files['document.pdf']?.kind, 'pdf');
  });

  it('safely exports multi-modal project archives to PKZip format', () => {
    const bundle = createMultiFileBundle({
      id: 'bundle_export',
      title: 'Export Test Bundle',
      files: [
        { path: 'index.html', content: '<html><body>Hello</body></html>', isEntry: true },
        { path: 'assets/badge.svg', content: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' },
        { path: 'media/sound.mp3', content: 'mock-audio' }
      ]
    });

    const zipBuffer = generateProjectZipArchive(bundle);
    assert.ok(zipBuffer.length > 100, 'Zip buffer must contain bytes');

    // Inspect PKZip signature 0x04034b50 ('PK\x03\x04')
    assert.equal(zipBuffer[0], 0x50);
    assert.equal(zipBuffer[1], 0x4b);
    assert.equal(zipBuffer[2], 0x03);
    assert.equal(zipBuffer[3], 0x04);
  });

  it('formatAudioTime accurately formats durations and guards against NaN / Infinity / negative inputs', () => {
    assert.equal(formatAudioTime(0), '0:00');
    assert.equal(formatAudioTime(9), '0:09');
    assert.equal(formatAudioTime(15.4), '0:15');
    assert.equal(formatAudioTime(65), '1:05');
    assert.equal(formatAudioTime(125), '2:05');
    assert.equal(formatAudioTime(3600), '60:00');
    assert.equal(formatAudioTime(NaN), '0:00');
    assert.equal(formatAudioTime(Infinity), '0:00');
    assert.equal(formatAudioTime(-10), '0:00');
  });

  it('validates audio file kind and prevents malformed path traversal in media files', () => {
    assert.equal(inferArtifactFileKind('sound/chime.wav'), 'audio');
    assert.equal(inferArtifactFileKind('sound/track.ogg'), 'audio');
    assert.throws(
      () => normalizeAndValidateArtifactPath('audio/../secret.wav'),
      ArtifactPathSecurityError
    );
    assert.throws(
      () => normalizeAndValidateArtifactPath('audio/aux.wav'),
      ArtifactPathSecurityError
    );
  });
});
