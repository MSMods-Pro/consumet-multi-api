import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';

import { ANIME, MANGA, MOVIES, BOOKS, COMICS, LIGHT_NOVELS, NEWS, META } from '../src/providers';

const app = express();
app.use(cors());
app.use(express.json());

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type ProviderMap = Record<string, new (...args: any[]) => any>;

const CATEGORIES: Record<string, ProviderMap> = {
  anime: ANIME as ProviderMap,
  manga: MANGA as ProviderMap,
  movies: MOVIES as ProviderMap,
  books: BOOKS as ProviderMap,
  comics: COMICS as ProviderMap,
  'light-novels': LIGHT_NOVELS as ProviderMap,
  news: NEWS as ProviderMap,
  meta: META as ProviderMap,
};

// key -> { className, Ctor }, keyed by lowercase name for clean URLs (e.g. "hianimead" -> HianimeAd)
const buildLookup = (map: ProviderMap) => {
  const lookup: Record<string, { className: string; Ctor: new (...args: any[]) => any }> = {};
  for (const className of Object.keys(map)) {
    lookup[className.toLowerCase()] = { className, Ctor: map[className] };
  }
  return lookup;
};

const CATEGORY_LOOKUP: Record<string, ReturnType<typeof buildLookup>> = {};
for (const cat of Object.keys(CATEGORIES)) {
  CATEGORY_LOOKUP[cat] = buildLookup(CATEGORIES[cat]);
}

const getProvider = (category: string, providerParam: string) => {
  const catLookup = CATEGORY_LOOKUP[category];
  if (!catLookup) {
    throw new HttpError(404, `Unknown category "${category}". Valid categories: ${Object.keys(CATEGORIES).join(', ')}`);
  }

  const entry = catLookup[providerParam.toLowerCase()];
  if (!entry) {
    throw new HttpError(
      404,
      `Unknown provider "${providerParam}" for category "${category}". Available: ${Object.keys(catLookup).join(', ') || '(none)'}`
    );
  }

  try {
    return new entry.Ctor();
  } catch (err) {
    throw new HttpError(500, `Failed to initialize provider "${entry.className}": ${(err as Error).message}`);
  }
};

const wrap =
  (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      next(err);
    }
  };

// -- Discovery routes ------------------------------------------------------

app.get('/', (_req: Request, res: Response) => {
  res.json({
    intro: 'Welcome to consumet-multi-api',
    usage: 'GET /:category/:provider/:query  →  search',
    categories: Object.keys(CATEGORIES),
    example: '/anime/hianimead/naruto',
    docs_route: '/providers',
  });
});

app.get('/providers', (_req: Request, res: Response) => {
  const listing: Record<string, string[]> = {};
  for (const cat of Object.keys(CATEGORY_LOOKUP)) {
    listing[cat] = Object.keys(CATEGORY_LOOKUP[cat]);
  }
  res.json({
    categories: listing,
    routes: {
      search: '/:category/:provider/:query',
      info: '/:category/:provider/info/:id             (anime, manga, movies)',
      watch: '/:category/:provider/watch/:episodeId     (anime, movies)  ?server=&type=sub|dub',
      servers: '/:category/:provider/servers/:episodeId  (anime, movies)',
      read: '/:category/:provider/read/:chapterId       (manga)',
    },
    example_flow: ['/anime/hianimead/naruto', '/anime/hianimead/info/<id-from-search>'],
  });
});

app.get('/:category', (req: Request, res: Response) => {
  const lookup = CATEGORY_LOOKUP[req.params.category];
  if (!lookup) {
    return res
      .status(404)
      .json({ message: `Unknown category "${req.params.category}". Valid: ${Object.keys(CATEGORIES).join(', ')}` });
  }
  res.json({ category: req.params.category, providers: Object.keys(lookup) });
});

// -- Search (works for every provider in every category) --------------------

app.get(
  '/:category/:provider/:query',
  wrap(async req => {
    const provider = getProvider(req.params.category, req.params.provider);
    return provider.search(req.params.query);
  })
);

// -- Info (anime / manga / movies) -------------------------------------------

app.get(
  '/:category/:provider/info/:id',
  wrap(async req => {
    const { category } = req.params;
    const provider = getProvider(category, req.params.provider);
    if (category === 'anime') return provider.fetchAnimeInfo(req.params.id);
    if (category === 'manga') return provider.fetchMangaInfo(req.params.id);
    if (category === 'movies') return provider.fetchMediaInfo(req.params.id);
    throw new HttpError(400, `"info" is not supported for category "${category}"`);
  })
);

// -- Watch / episode sources (anime / movies) --------------------------------

app.get(
  '/:category/:provider/watch/:episodeId',
  wrap(async req => {
    const { category } = req.params;
    if (category !== 'anime' && category !== 'movies') {
      throw new HttpError(400, `"watch" is not supported for category "${category}"`);
    }
    const provider = getProvider(category, req.params.provider);
    const server = typeof req.query.server === 'string' ? req.query.server : undefined;
    const type = req.query.type === 'dub' ? 'dub' : 'sub';
    // HianimeAd takes (episodeId, server, type); most other providers take (episodeId, server)
    return provider.fetchEpisodeSources(req.params.episodeId, server, type);
  })
);

// -- Episode servers (anime / movies) ----------------------------------------

app.get(
  '/:category/:provider/servers/:episodeId',
  wrap(async req => {
    const { category } = req.params;
    if (category !== 'anime' && category !== 'movies') {
      throw new HttpError(400, `"servers" is not supported for category "${category}"`);
    }
    const provider = getProvider(category, req.params.provider);
    return provider.fetchEpisodeServers(req.params.episodeId);
  })
);

// -- Read / chapter pages (manga) --------------------------------------------

app.get(
  '/:category/:provider/read/:chapterId',
  wrap(async req => {
    const { category } = req.params;
    if (category !== 'manga') {
      throw new HttpError(400, `"read" is not supported for category "${category}"`);
    }
    const provider = getProvider(category, req.params.provider);
    return provider.fetchChapterPages(req.params.chapterId);
  })
);

// -- Fallback / error handling -----------------------------------------------

app.use((req: Request, res: Response) => {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  res.status(status).json({ message: err.message });
});

export default app;
