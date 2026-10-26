// Type declarations for check-doc-links.mjs (the project typechecks with allowJs=false).

export declare function stripInlineCode(line: string): string;
export declare function inlineTargets(line: string): string[];
export declare function referenceTarget(line: string): string | undefined;
export declare function isExternal(target: string): boolean;
export declare function codeLines(lines: string[]): boolean[];
export declare function markdownTargets(text: string): Array<{ line: number; target: string }>;
