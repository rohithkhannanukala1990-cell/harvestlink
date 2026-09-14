/**
 * Vite configuration for the Harvestlink frontend.
 * Enables React fast refresh and Tailwind CSS via the official Vite plugin.
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
  },
});
