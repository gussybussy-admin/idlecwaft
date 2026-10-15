// WDBC table reader. Fields are raw u32; callers interpret ints/floats/strings by column.
export interface DBC {
  records: number;
  fields: number;
  recordSize: number;
  stringSize: number;
  u32(r: number, f: number): number;
  i32(r: number, f: number): number;
  f32(r: number, f: number): number;
  str(r: number, f: number): string;
  isStringStart(off: number): boolean;
  rows(): number[];
}

export function parseDBC(buf: Buffer): DBC {
  if (buf.toString('latin1', 0, 4) !== 'WDBC') throw new Error('not a WDBC file');
  const records = buf.readUInt32LE(4), fields = buf.readUInt32LE(8);
  const recordSize = buf.readUInt32LE(12), stringSize = buf.readUInt32LE(16);
  const dataStart = 20, strStart = dataStart + records * recordSize;
  const strings = buf.subarray(strStart, strStart + stringSize);
  const at = (r: number, f: number) => dataStart + r * recordSize + f * 4;
  return {
    records, fields, recordSize, stringSize,
    u32: (r, f) => buf.readUInt32LE(at(r, f)),
    i32: (r, f) => buf.readInt32LE(at(r, f)),
    f32: (r, f) => buf.readFloatLE(at(r, f)),
    str: (r, f) => {
      const off = buf.readUInt32LE(at(r, f));
      if (off >= stringSize) return '';
      const end = strings.indexOf(0, off);
      return strings.toString('utf8', off, end < 0 ? stringSize : end);
    },
    isStringStart: off => off === 0 || (off < stringSize && strings[off - 1] === 0),
    rows: () => Array.from({ length: records }, (_, r) => r),
  };
}
