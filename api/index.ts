import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';

import { ANIME } from '../src/providers';

const app = express();
app.use(cors());
app.use(express.json());

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      next(err);
    }
  };

app.get('/', (_req: Request, res: Response) => {
  res.json({
    intro: 'Welcome to consumet-multi-api',
    routes: [
      '/anime/hianimead/:query',
      '/anime/hianimead/info/:id',
      '/anime/hianimead/servers/:episodeId',
      '/anime/hianimead/watch/:episodeId',
    ],
    docs: 'https://github.com/consumet/consumet.ts',
  });
});

// HianimeAd (hianime.ad) routes
app.get(
  '/anime/hianimead/:query',
  wrap(async req => {
    const hianimead = new ANIME.HianimeAd();
    return hianimead.search(req.params.query);
  })
);

app.get(
  '/anime/hianimead/info/:id',
  wrap(async req => {
    const hianimead = new ANIME.HianimeAd();
    return hianimead.fetchAnimeInfo(req.params.id);
  })
);

app.get(
  '/anime/hianimead/servers/:episodeId',
  wrap(async req => {
    const hianimead = new ANIME.HianimeAd();
    return hianimead.fetchEpisodeServers(req.params.episodeId);
  })
);

app.get(
  '/anime/hianimead/watch/:episodeId',
  wrap(async req => {
    const hianimead = new ANIME.HianimeAd();
    const server = typeof req.query.server === 'string' ? req.query.server : undefined;
    const type = req.query.type === 'dub' ? 'dub' : 'sub';
    return hianimead.fetchEpisodeSources(req.params.episodeId, server, type);
  })
);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ message: err.message });
});

export default app;
