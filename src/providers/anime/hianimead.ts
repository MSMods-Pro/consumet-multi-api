import { load } from 'cheerio';

import {
  AnimeParser,
  ISearch,
  IAnimeInfo,
  IAnimeResult,
  ISource,
  IEpisodeServer,
  IAnimeEpisode,
  MediaFormat,
} from '../../models';

/**
 * HianimeAd — provider for `hianime.ad`.
 *
 * NOTE: this is a **different site/markup** than `hianime.ad`'s legacy sister
 * (the `Hianime` provider, which still uses the old `hianime.to`-style ajax
 * endpoints). This provider was built directly against the `hianime.ad`
 * markup: `/filter?keyword=`, `/watch/:slug/ep-:num`, `.flw-item` cards,
 * `.ssl-item.ep-item` episode list and `data-video` embed servers, with a
 * packed-JS (`eval(function(p,a,c,k,e,d)...)`) unpacker used as a fallback
 * to resolve the final `.m3u8` stream.
 */
class HianimeAd extends AnimeParser {
  override readonly name = 'HianimeAd';
  protected override baseUrl = 'https://hianime.ad';
  protected override logo =
    'https://is3-ssl.mzstatic.com/image/thumb/Purple112/v4/7e/91/00/7e9100ee-2b62-0942-4cdc-e9b93252ce1c/source/512x512bb.jpg';
  protected override classPath = 'ANIME.HianimeAd';

  private readonly UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

  /**
   * Search for anime
   * @param query Search query string
   * @returns Promise<ISearch<IAnimeResult>>
   */
  override search = async (query: string): Promise<ISearch<IAnimeResult>> => {
    try {
      const { data } = await this.client.get(`${this.baseUrl}/filter`, {
        params: { keyword: query },
        headers: { 'User-Agent': this.UA },
      });
      const $ = load(data);

      const results: IAnimeResult[] = [];
      $('.flw-item').each((_, el) => {
        const card = $(el);
        const href = card.find('.dynamic-name').attr('href') || '';
        const id = href.replace('/anime/', '').split('?')[0];
        if (!id) return;

        results.push({
          id,
          title: card.find('.dynamic-name').text().trim(),
          url: `${this.baseUrl}${href}`,
          image: card.find('.film-poster-img').attr('data-src') || card.find('.film-poster-img').attr('src'),
          type: card.find('.fdi-item').first().text().trim() as MediaFormat,
          releaseDate: card.find('.fdi-duration').text().trim(),
          sub: parseInt(card.find('.tick-sub').text().trim()) || 0,
          dub: parseInt(card.find('.tick-dub').text().trim()) || 0,
        });
      });

      return { results };
    } catch (err) {
      throw new Error('Something went wrong. Please try again later.');
    }
  };

  /**
   * Fetch anime information
   * @param id Anime slug (e.g. `some-anime-title-19)
   * @returns Promise<IAnimeInfo>
   */
  override fetchAnimeInfo = async (id: string): Promise<IAnimeInfo> => {
    const info: IAnimeInfo = { id, title: '' };
    try {
      const { data } = await this.client.get(`${this.baseUrl}/anime/${id}`, {
        headers: { 'User-Agent': this.UA },
      });
      const $ = load(data);

      info.title = $('.dynamic-name[data-en]').attr('data-en') || $('.film-name.dynamic-name').text().trim();
      info.japaneseTitle = $('.dynamic-name[data-jp]').attr('data-jp') || undefined;
      info.image = $('.film-poster-img').attr('src');
      info.cover =
        $('.anis-cover')
          .css('background-image')
          ?.replace(/url\(['"]?(.*?)['"]?\)/, '$1') || undefined;
      info.description = $('.film-description .text').text().trim().replace(/\s+/g, ' ') || undefined;
      info.url = `${this.baseUrl}/anime/${id}`;
      info.type = ($('.film-stats .item').first().text().trim() || undefined) as MediaFormat;
      info.releaseDate = $('.film-stats .item').last().text().trim() || undefined;
      info.hasSub = $('.film-stats .tick-sub').length > 0;
      info.hasDub = $('.film-stats .tick-dub').length > 0;

      info.genres = [];
      $('.anisc-info .item').each((_, el) => {
        const $el = $(el);
        const label = $el.find('.item-head').text().replace(':', '').trim().toLowerCase();
        if (label === 'genres') {
          $el.find('a').each((_, a) => {
            const g = $(a).text().trim();
            if (g) info.genres?.push(g);
          });
        }
      });

      const episodes = await this.fetchEpisodesList(id);
      info.episodes = episodes;
      info.totalEpisodes = episodes.length;

      return info;
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  /**
   * Internal helper: list episodes for a given anime slug
   */
  private fetchEpisodesList = async (slug: string): Promise<IAnimeEpisode[]> => {
    const { data } = await this.client.get(`${this.baseUrl}/watch/${slug}/ep-1`, {
      headers: { 'User-Agent': this.UA },
    });
    const $ = load(data);
    const episodes: IAnimeEpisode[] = [];

    $('.ssl-item.ep-item').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      const number = parseInt($el.attr('data-num') || '', 10);
      const title = $el.attr('title') || $el.find('.ep-name').text().trim() || `Episode ${number}`;
      if (number && href) {
        episodes.push({
          id: `${slug}$episode$${number}`,
          number,
          title,
          url: `${this.baseUrl}${href}`,
        });
      }
    });

    return episodes.sort((a, b) => a.number - b.number);
  };

  /**
   * Fetch episode video sources
   * @param episodeId Episode ID in the format `slug$episode$number` (as returned by `fetchAnimeInfo`)
   * @param server Optional server label (defaults to the first available server for the requested type)
   * @param type `sub` or `dub` (default: `sub`)
   * @returns Promise<ISource>
   */
  override fetchEpisodeSources = async (
    episodeId: string,
    server?: string,
    type: 'sub' | 'dub' = 'sub'
  ): Promise<ISource> => {
    if (!episodeId.includes('$episode$')) throw new Error('Invalid episode id');
    const [slug, numStr] = episodeId.split('$episode$');
    const number = parseInt(numStr, 10);

    const servers = await this.fetchEpisodeServers(episodeId);
    if (!servers.length) throw new Error('No servers found for this episode');

    const typeServers = servers.filter(s => (s.type as string) === type);
    const pool = typeServers.length ? typeServers : servers;
    const chosen = (server ? pool.find(s => s.name.toLowerCase() === server.toLowerCase()) : undefined) ?? pool[0];

    if (!chosen) throw new Error("Couldn't find server. Try another server");

    return this.resolveEmbed(chosen.url, `${this.baseUrl}/watch/${slug}/ep-${number}`);
  };

  /**
   * Fetch episode servers (embeds) for an episode
   * @param episodeId Episode ID in the format `slug$episode$number`
   */
  override fetchEpisodeServers = async (episodeId: string): Promise<IEpisodeServer[]> => {
    if (!episodeId.includes('$episode$')) throw new Error('Invalid episode id');
    const [slug, numStr] = episodeId.split('$episode$');
    const number = parseInt(numStr, 10);

    const { data: html } = await this.client.get(`${this.baseUrl}/watch/${slug}/ep-${number}`, {
      headers: { 'User-Agent': this.UA },
    });
    const $ = load(html);

    const servers: IEpisodeServer[] = [];
    $('.ps__-list.server-items').each((_, el) => {
      const $el = $(el);
      const type = ($el.attr('data-id') || '').toLowerCase();
      $el.find('[data-video]').each((_, item) => {
        const $item = $(item);
        const videoUrl = $item.attr('data-video') || '';
        const label = $item.text().trim();
        let embedUrl = videoUrl;
        if (videoUrl.includes('?sub=')) {
          embedUrl = videoUrl.split('?sub=')[0];
        } else if (videoUrl.includes('?')) {
          embedUrl = videoUrl.split('?')[0];
        }
        if (embedUrl) {
          servers.push({ name: label, url: embedUrl, type });
        }
      });
    });

    return servers;
  };

  /**
   * Internal: resolve an embed URL to a playable HLS source, first trying the
   * plain `const src = "...master.m3u8..."` pattern, then falling back to
   * unpacking a `eval(function(p,a,c,k,e,d)...)` packed script.
   */
  private resolveEmbed = async (embedUrl: string, referer: string): Promise<ISource> => {
    try {
      const { data: html } = await this.client.get(embedUrl, {
        headers: { 'User-Agent': this.UA },
      });

      const srcMatch = html.match(/const src\s*=\s*"(https:\/\/[^"]+?\/master\.m3u8[^"]*)"/);
      if (srcMatch) {
        const subMatch = html.match(/const subtitle\s*=\s*"([^"]+)"/);
        return await this.parseMasterM3u8(srcMatch[1], embedUrl, subMatch ? subMatch[1] : undefined);
      }

      const unpacked = this.unpackPackedScript(html);
      if (unpacked) {
        const domain = new URL(embedUrl).hostname;
        const hlsMatch = unpacked.match(/"hls4":"([^"]+)"/) || unpacked.match(/"hls3":"([^"]+)"/);
        if (hlsMatch) {
          let streamUrl = hlsMatch[1];
          if (streamUrl.startsWith('/')) streamUrl = `https://${domain}${streamUrl}`;
          return await this.parseMasterM3u8(streamUrl, embedUrl, undefined);
        }
      }

      throw new Error('No HLS stream found');
    } catch (err) {
      throw new Error((err as Error).message);
    }
  };

  private parseMasterM3u8 = async (masterUrl: string, embedUrl: string, subtitle?: string): Promise<ISource> => {
    const { data: m3u8 } = await this.client.get(masterUrl, {
      headers: { 'User-Agent': this.UA, Referer: new URL(embedUrl).origin },
    });

    const base = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
    const sources: ISource['sources'] = [];
    const lines: string[] = m3u8.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const resMatch = lines[i].match(/RESOLUTION=(\d+x(\d+))/);
      if (i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
        const pl = lines[i + 1].trim();
        sources.push({
          url: pl.startsWith('http') ? pl : base + pl,
          quality: resMatch ? `${resMatch[2]}p` : 'unknown',
          isM3U8: true,
        });
      }
    }

    if (!sources.length) {
      sources.push({ url: masterUrl, quality: 'auto', isM3U8: true });
    }

    return {
      headers: { Referer: new URL(embedUrl).origin },
      sources,
      subtitles: subtitle ? [{ url: subtitle, lang: 'English' }] : [],
      embedURL: embedUrl,
    };
  };

  /**
   * Unpacks a Dean Edwards-style `eval(function(p,a,c,k,e,d)...)` packed script.
   */
  private unpackPackedScript = (html: string): string | null => {
    const idx = html.indexOf('eval(function(p,a,c,k,e,d)');
    if (idx === -1) return null;

    const fnEndIdx = html.indexOf("}('", idx);
    if (fnEndIdx === -1) return null;

    const callStart = fnEndIdx + 1;
    let depth = 0,
      end = -1;
    for (let i = callStart; i < html.length; i++) {
      if (html[i] === '(') depth++;
      else if (html[i] === ')') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) return null;

    const argsStr = html.substring(callStart + 1, end - 1);
    const args: string[] = [];
    let d = 0,
      cur = '',
      inStr = false,
      sq = false;
    for (let i = 0; i < argsStr.length; i++) {
      const ch = argsStr[i];
      if (inStr) {
        cur += ch;
        if (ch === (sq ? "'" : '"') && argsStr[i - 1] !== '\\') inStr = false;
      } else if (ch === "'" || ch === '"') {
        cur += ch;
        inStr = true;
        sq = ch === "'";
      } else if (ch === '(' || ch === '[' || ch === '{') {
        d++;
        cur += ch;
      } else if (ch === ')' || ch === ']' || ch === '}') {
        d--;
        cur += ch;
      } else if (ch === ',' && d === 0 && !inStr) {
        args.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());
    if (args.length < 4) return null;

    const packedStr = args[0].replace(/^'|'$/g, '');
    const radix = parseInt(args[1]);
    const count = parseInt(args[2]);
    const dictM = args[3].match(/^'(.+)'\.split/);
    if (!dictM) return null;
    const dict = dictM[1].split('|');

    let result = packedStr;
    for (let i = 0; i < Math.min(count, dict.length); i++) {
      if (dict[i]) {
        const re = new RegExp('\\b' + i.toString(radix) + '\\b', 'g');
        result = result.replace(re, dict[i]);
      }
    }
    return result;
  };
}

export default HianimeAd;
