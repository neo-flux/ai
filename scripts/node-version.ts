// Node strips TypeScript types by default from 22.18 on the 22 line, and from 23.6 onwards.
// Sources: nodejs.org/docs/latest-v22.x/api/typescript.html and latest-v23.x, History tables.
export function stripsTypesByDefault(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.\d+/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 22) return minor >= 18;
  if (major === 23) return minor >= 6;
  return major > 23;
}
