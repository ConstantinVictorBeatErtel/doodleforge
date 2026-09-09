import { afterEach, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import App from './App';

vi.mock('convex/react', () => ({
  useConvex: () => ({}),
  useMutation: () => vi.fn(),
  useQuery: () => [{ _id: 'old-room', status: 'ready', name: 'Previous room' }],
}));
vi.mock('./WorldApp', () => ({ default: ({ initialWorldId }: { initialWorldId: string }) => <div>Opened world: {initialWorldId}</div> }));
afterEach(() => vi.unstubAllGlobals());

test('root URL stays on the capture entry even when an old room exists', () => {
  vi.stubGlobal('location', new URL('https://example.com/'));
  const html = renderToStaticMarkup(<App />);
  expect(html).toContain('Choose a capture');
  expect(html).toContain('video/mp4');
  expect(html).not.toContain('Opened world:');
});

test('only an explicit world URL opens that room', () => {
  vi.stubGlobal('location', new URL('https://example.com/?world=my-new-room'));
  expect(renderToStaticMarkup(<App />)).toContain('Opened world: my-new-room');
});

test('capture entry defaults to fast preview and offers higher detail', () => {
  vi.stubGlobal('location', new URL('https://example.com/'));
  const html = renderToStaticMarkup(<App />);
  expect(html).toMatch(/value="marble-1.0-draft" selected=""/);
  expect(html).toContain('Higher detail');
});
