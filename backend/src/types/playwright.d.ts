// Module declaration for the optional playwright dependency. The
// browser automation route imports playwright dynamically so the
// backend still boots when the package isn't installed; we just
// declare a minimal interface here so TypeScript stops complaining.

declare module "playwright" {
  export interface BrowserContext {
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }
  export interface Page {
    goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    click(selector: string, opts?: { timeout?: number }): Promise<void>;
    fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void>;
    waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
    waitForTimeout(ms: number): Promise<void>;
    screenshot(opts: { path: string; fullPage?: boolean }): Promise<Uint8Array>;
    url(): string;
    title(): Promise<string>;
    $$(selector: string): Promise<Array<ElementHandle>>;
  }
  export interface ElementHandle {
    getAttribute(name: string): Promise<string | null>;
    textContent(): Promise<string | null>;
  }
  export interface Browser {
    newContext(opts?: Record<string, unknown>): Promise<BrowserContext>;
  }
  export const chromium: {
    launch(opts?: Record<string, unknown>): Promise<Browser>;
  };
}

// Optional document generation libraries — same story. None of these
// are declared in package.json on purpose; the documents route tries
// to import them at runtime and falls back to .md when they're
// missing. These declarations exist purely to satisfy the typechecker.

declare module "docx" {
  export const Document: new (opts: object) => unknown;
  export const Packer: { toBuffer: (d: unknown) => Promise<Uint8Array> };
  export const Paragraph: new (opts: object) => object;
  export const HeadingLevel: Record<string, number>;
  export const TextRun: new (opts: string | object) => object;
}

declare module "xlsx" {
  export const utils: {
    book_new: () => unknown;
    aoa_to_sheet: (a: unknown[][]) => unknown;
    book_append_sheet: (b: unknown, s: unknown, n: string) => void;
  };
  export const write: (b: unknown, opts: { type: string; bookType: string }) => Uint8Array;
}

declare module "pdfkit" {
  const PDFDocument: new (opts?: Record<string, unknown>) => unknown;
  export default PDFDocument;
}

declare module "pptxgenjs" {
  const PptxGen: new () => unknown;
  export default PptxGen;
}