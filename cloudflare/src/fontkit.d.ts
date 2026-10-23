declare module 'fontkit' {
  export interface FontGlyph { id: number; codePoints: number[]; }
  export interface GlyphPosition { xAdvance: number; yAdvance: number; xOffset: number; yOffset: number; }
  export interface LayoutEngine { constructor: new (font: Font) => LayoutEngine; }
  export interface Font { _layoutEngine: LayoutEngine; layout(text: string): { glyphs: FontGlyph[]; positions: GlyphPosition[] }; }
  export function create(data: Uint8Array): Font;
}
