// Type declarations for annotations.mjs (the project typechecks with allowJs=false).
export declare function encodeAnnotation(text: string): string;
export declare function decodeAnnotation(text: string): string;
export declare function encodeProperty(text: string): string;
export declare function chunkForAnnotations(text: string, max?: number): string[];
export declare function stripLeadingCommentHeader(text: string): string;
