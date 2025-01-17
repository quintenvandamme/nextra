import type { LoaderOptions } from './types'

import path from 'path'
import grayMatter from 'gray-matter'
import slash from 'slash'
import { LoaderContext } from 'webpack'
import { Repository } from '@napi-rs/simple-git'

import { addPage } from './content-dump'
import { getLocaleFromFilename } from './utils'
import { compileMdx } from './compile'
import { getPageMap, findPagesDir } from './page-map'
import { collectFiles } from './plugin'

const extension = /\.mdx?$/
const isProductionBuild = process.env.NODE_ENV === 'production'

// TODO: create this as a webpack plugin.
const indexContentEmitted = new Set()

const pagesDir = path.resolve(findPagesDir())

const [repository, gitRoot] = (function () {
  try {
    const repo = Repository.discover(process.cwd())
    // repository.path() returns the `/path/to/repo/.git`, we need the parent directory of it
    const gitRoot = path.join(repo.path(), '..')
    return [repo, gitRoot]
  } catch (e) {
    console.warn('Init git repository failed', e)
    return []
  }
})()

async function loader(
  context: LoaderContext<LoaderOptions>,
  source: string
): Promise<string> {
  context.cacheable(true)

  const options = context.getOptions()
  let {
    theme,
    themeConfig,
    defaultLocale,
    unstable_flexsearch,
    unstable_staticImage,
    mdxOptions,
    pageMapCache
  } = options

  const { resourcePath } = context
  const filename = resourcePath.slice(resourcePath.lastIndexOf('/') + 1)
  const fileLocale = getLocaleFromFilename(filename)

  // Check if there's a theme provided
  if (!theme) {
    throw new Error('No Nextra theme found!')
  }

  const { items: pageMapResult, fileMap } = isProductionBuild
    ? pageMapCache.get()!
    : await collectFiles(pagesDir, '/')

  const [pageMap, route, title] = getPageMap(
    resourcePath,
    pageMapResult,
    fileMap,
    defaultLocale
  )

  if (!isProductionBuild) {
    // Add the entire directory `pages` as the dependency
    // so we can generate the correct page map.
    context.addContextDependency(pagesDir)
  } else {
    // We only add meta files as dependencies for production build,
    // so we can do incremental builds.
    Object.entries(fileMap).forEach(([filePath, { name, meta, locale }]) => {
      if (
        name === 'meta.json' &&
        meta &&
        (!fileLocale || locale === fileLocale)
      ) {
        context.addDependency(filePath)
      }
    })
  }

  // Extract frontMatter information if it exists
  let { data, content } = grayMatter(source)

  let layout = theme
  let layoutConfig = themeConfig || null

  // Relative path instead of a package name
  if (theme.startsWith('.') || theme.startsWith('/')) {
    layout = path.resolve(theme)
  }
  if (layoutConfig) {
    layoutConfig = slash(path.resolve(layoutConfig))
  }

  if (isProductionBuild && indexContentEmitted.has(filename)) {
    unstable_flexsearch = false
  }

  const { result, titleText, headings, hasH1, structurizedData } =
    await compileMdx(
      content,
      mdxOptions,
      {
        unstable_staticImage,
        unstable_flexsearch
      },
      resourcePath
    )
  content = result.replace('export default MDXContent;', '')

  if (unstable_flexsearch) {
    // We only add .MD and .MDX contents
    if (extension.test(filename) && data.searchable !== false) {
      addPage({
        fileLocale: fileLocale || 'default',
        route,
        title,
        data,
        structurizedData
      })
    }

    indexContentEmitted.add(filename)
  }

  let timestamp: number | undefined
  if (repository && gitRoot) {
    if (repository.isShallow()) {
      if (process.env.VERCEL) {
        console.warn(
          `The repository is shallow cloned, so the latest modified time will not be presented. Set the VERCEL_DEEP_CLONE=true environment variable to enable deep cloning.`
        )
      } else if (process.env.GITHUB_ACTION) {
        console.warn(
          `The repository is shallow cloned, so the latest modified time will not be presented. See https://github.com/actions/checkout#fetch-all-history-for-all-tags-and-branches to fetch all the history.`
        )
      } else {
        console.warn(
          `The repository is shallow cloned, so the latest modified time will not be presented.`
        )
      }
    }
    try {
      timestamp = await repository.getFileLatestModifiedDateAsync(
        path.relative(gitRoot, resourcePath)
      )
    } catch {
      // Failed to get timestamp for this file. Silently ignore it.
    }
  }

  const layoutConfigImport = layoutConfig
    ? `import __nextra_layoutConfig__ from '${layoutConfig}'`
    : ''

  return `
import __nextra_withLayout__ from '${layout}'
import { withSSG as __nextra_withSSG__ } from 'nextra/ssg'
${layoutConfigImport}

const __nextra_pageMap__ = ${JSON.stringify(pageMap)}

globalThis.__nextra_internal__ = {
  pageMap: __nextra_pageMap__,
  route: ${JSON.stringify(route)}
}

const NextraLayout = __nextra_withSSG__(__nextra_withLayout__({
  filename: "${slash(filename)}",
  route: "${slash(route)}",
  meta: ${JSON.stringify(data)},
  pageMap: __nextra_pageMap__,
  titleText: ${JSON.stringify(titleText)},
  headings: ${JSON.stringify(headings)},
  hasH1: ${JSON.stringify(hasH1)},
  ${timestamp ? `timestamp: ${timestamp},\n` : ''}
}, ${layoutConfig ? '__nextra_layoutConfig__' : 'null'}))

${content}

function NextraPage(props) {
  return (
    <NextraLayout {...props}>
      <MDXContent />
    </NextraLayout>
  )
}
NextraPage.getLayout = NextraLayout.getLayout

export default NextraPage
`.trimStart()
}

export default function syncLoader(
  this: LoaderContext<LoaderOptions>,
  source: string,
  callback: (err?: null | Error, content?: string | Buffer) => void
) {
  loader(this, source)
    .then(result => callback(null, result))
    .catch(err => callback(err))
}
