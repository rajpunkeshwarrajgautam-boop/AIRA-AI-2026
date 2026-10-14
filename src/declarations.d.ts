declare module 'katex' {
  const katex: {
    renderToString(
      tex: string,
      options?: {
        displayMode?: boolean;
        throwOnError?: boolean;
        trust?: boolean;
        strict?: boolean | string;
        output?: 'html' | 'mathml' | 'htmlAndMathml';
      }
    ): string;
  };
  export default katex;
}
