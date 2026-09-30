/**
 * Scaffolds a buildable Vite project (React or Vue) with one placeholder page
 * per route. Returns path → file text; nothing is written here.
 */
import type { Gap, StackFingerprint } from '../bundle/types';
import type { ApiModel } from '../analysis/apiModel';
import type { RouteModel } from '../analysis/routeModel';
import { pascal } from './types';

/** What `generateProject` needs; `name` becomes the package name and page title. */
export interface ProjectInput {
  name: string;
  stack: StackFingerprint;
  routes: RouteModel['routes'];
  api: ApiModel;
  gaps: Gap[];
}

/** `/` → Home; `/users/:id` → UsersById. Mirrors typeNameFor's convention. */
export function pageNameFor(path: string): string {
  if (path === '/') return 'Home';
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith(':') ? `By${pascal(segment.slice(1))}` : pascal(segment)
    )
    .join('');
}

function dependencies(stack: StackFingerprint): Record<string, string> {
  const version = stack.frameworkVersion ?? 'latest';
  const routerVersion = stack.routerVersion ?? 'latest';

  if (stack.framework === 'vue') {
    return { vue: version, 'vue-router': routerVersion };
  }
  return {
    react: version,
    'react-dom': version,
    'react-router-dom': routerVersion,
  };
}

function devDependencies(stack: StackFingerprint): Record<string, string> {
  const base: Record<string, string> = {
    typescript: '^5.7.3',
    vite: '^5.4.21',
    hono: '^4.6.0',
  };
  if (stack.framework === 'vue') {
    base['@vitejs/plugin-vue'] = '^5.2.0';
  } else {
    base['@vitejs/plugin-react'] = '^4.5.1';
    base['@types/react'] = '^18.3.0';
    base['@types/react-dom'] = '^18.3.0';
  }
  return base;
}

function pageHeader(route: ProjectInput['routes'][number]): string {
  const lines = [
    '/**',
    ` * Route: ${route.path}`,
    route.endpoints.length > 0
      ? ` * Observed endpoints: ${route.endpoints.join(', ')}`
      : ' * Observed endpoints: none',
  ];
  if (!route.visited) {
    lines.push(
      ' *',
      ' * RAIDR-GAP: this route was never visited during capture; there is no',
      ' * runtime evidence for its content. Only the router shell is reproduced.'
    );
  }
  lines.push(' */');
  return lines.join('\n');
}

function reactPage(route: ProjectInput['routes'][number]): string {
  const name = pageNameFor(route.path);
  return `${pageHeader(route)}
export function ${name}() {
  return (
    <main>
      <h1>${name}</h1>
    </main>
  );
}

export default ${name};
`;
}

function vuePage(route: ProjectInput['routes'][number]): string {
  const name = pageNameFor(route.path);
  return `<script setup lang="ts">
${pageHeader(route)}
</script>

<template>
  <main>
    <h1>${name}</h1>
  </main>
</template>
`;
}

function reactRouter(routes: ProjectInput['routes']): string {
  const eager = routes.filter((route) => !route.lazy);
  const lazyRoutes = routes.filter((route) => route.lazy);

  const eagerImports = eager
    .map(
      (route) =>
        `import { ${pageNameFor(route.path)} } from './pages/${pageNameFor(route.path)}';`
    )
    .join('\n');

  const lazyImports = lazyRoutes
    .map(
      (route) =>
        `const ${pageNameFor(route.path)} = lazy(() => import('./pages/${pageNameFor(route.path)}'));`
    )
    .join('\n');

  const entries = routes
    .map((route) => {
      const name = pageNameFor(route.path);
      const element = route.lazy
        ? `<Suspense fallback={null}><${name} /></Suspense>`
        : `<${name} />`;
      return `  { path: '${route.path}', element: ${element} },`;
    })
    .join('\n');

  return `import { lazy, Suspense } from 'react';
import { createBrowserRouter } from 'react-router-dom';
${eagerImports}

${lazyImports}

export const router = createBrowserRouter([
${entries}
]);
`;
}

function vueRouter(routes: ProjectInput['routes']): string {
  const entries = routes
    .map(
      (route) =>
        `    { path: '${route.path}', component: () => import('./pages/${pageNameFor(route.path)}.vue') },`
    )
    .join('\n');

  return `import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
${entries}
  ],
});
`;
}

/**
 * Generates package.json, tsconfig.json, vite.config.ts, index.html, the
 * router and one page per route. React is used unless `stack.framework` is
 * `'vue'`. Framework and router versions come from the fingerprint (`latest`
 * when unknown). Unvisited routes get a `RAIDR-GAP` header comment, and a
 * non-empty `gaps` list adds `RAIDR-GAPS.md`. Lazy routes use `React.lazy` in
 * React; in Vue every route is a dynamic import.
 */
export function generateProject(input: ProjectInput): Record<string, string> {
  const isVue = input.stack.framework === 'vue';
  const files: Record<string, string> = {};

  files['package.json'] = JSON.stringify(
    {
      name: input.name,
      private: true,
      type: 'module',
      scripts: {
        dev: 'vite',
        build: 'vite build',
        typecheck: 'tsc --noEmit',
        replay: 'bun run server/replay.ts',
      },
      dependencies: dependencies(input.stack),
      devDependencies: devDependencies(input.stack),
    },
    null,
    2
  );

  files['tsconfig.json'] = JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        ...(isVue ? {} : { jsx: 'react-jsx' }),
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        resolveJsonModule: true,
      },
      include: ['src'],
    },
    null,
    2
  );

  files['vite.config.ts'] = isVue
    ? `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({ plugins: [vue()] });
`
    : `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()] });
`;

  files['index.html'] = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${input.name}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.${isVue ? 'ts' : 'tsx'}"></script>
  </body>
</html>
`;

  if (isVue) {
    files['src/main.ts'] = `import { createApp } from 'vue';
import { router } from './router';
import App from './App.vue';

createApp(App).use(router).mount('#app');
`;
    files['src/App.vue'] = `<template>
  <RouterView />
</template>
`;
    files['src/router.ts'] = vueRouter(input.routes);
    for (const route of input.routes) {
      files[`src/pages/${pageNameFor(route.path)}.vue`] = vuePage(route);
    }
  } else {
    files['src/main.tsx'] = `import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';

const container = document.getElementById('app');
if (!container) throw new Error('#app not found');
createRoot(container).render(<RouterProvider router={router} />);
`;
    files['src/router.tsx'] = reactRouter(input.routes);
    for (const route of input.routes) {
      files[`src/pages/${pageNameFor(route.path)}.tsx`] = reactPage(route);
    }
  }

  if (input.gaps.length > 0) {
    files['RAIDR-GAPS.md'] = [
      '# Capture gaps',
      '',
      'These resources were requested by the original app but not captured.',
      'Anything depending on them is missing evidence, not merely unimplemented.',
      '',
      ...input.gaps.map(
        (gap) => `- \`${gap.reason}\` — ${gap.url}${gap.detail ? ` (${gap.detail})` : ''}`
      ),
    ].join('\n');
  }

  return files;
}
