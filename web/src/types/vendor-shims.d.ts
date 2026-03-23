declare module "highlight.js/lib/core" {
  // biome-ignore lint/suspicious/noExplicitAny: vendor type stub
  const hljs: any;
  export default hljs;
}

declare module "highlight.js/lib/languages/*" {
  // biome-ignore lint/suspicious/noExplicitAny: vendor type stub
  const language: any;
  export default language;
}

declare module "marked" {
  // biome-ignore lint/suspicious/noExplicitAny: vendor type stub
  export const marked: any;
}

declare module "lucide/dist/esm/createElement.js" {
  // biome-ignore lint/suspicious/noExplicitAny: vendor type stub
  const createElement: any;
  export default createElement;
}

declare module "lucide/dist/esm/icons/*.js" {
  // biome-ignore lint/suspicious/noExplicitAny: vendor type stub
  const icon: any;
  export default icon;
}
