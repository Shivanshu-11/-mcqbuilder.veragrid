import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// GitHub Pages project URL: https://<user>.github.io/<repo>/
// In GitHub Actions, GITHUB_REPOSITORY is "owner/repo" — base must be "/<repo>/".
function productionBase() {
  if (process.env.GITHUB_REPOSITORY) {
    const repo = process.env.GITHUB_REPOSITORY.split('/')[1]
    return `/${repo}/`
  }
  // Local `npm run build` (no Actions): keep in sync with your GitHub repo name
  return '/-mcqbuilder.veragrid/'
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'development' ? '/' : productionBase(),
}))
