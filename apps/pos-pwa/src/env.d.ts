// The literal `process.env.NEXT_PUBLIC_*` form is what Next.js inlines into the browser bundle; declaring the key makes TypeScript allow it.
declare namespace NodeJS {
  interface ProcessEnv {
    NEXT_PUBLIC_API_BASE_URL?: string;
  }
}
