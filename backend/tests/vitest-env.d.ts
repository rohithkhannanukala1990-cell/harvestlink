/// <reference types="vitest/config" />
import "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    DATABASE_URL: string;
  }
}
