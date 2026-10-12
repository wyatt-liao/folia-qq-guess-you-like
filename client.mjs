// mods/qq-guess-you-like/client.mjs
/**
 * QQ 音乐个性化「猜你喜欢」与电台推荐模组 (QQ Music Guess-You-Like & Radio Mod)
 *
 * 作用：
 * 基于 Folium internals 为 QQ 音乐音源接入真正的「猜你喜欢」个性化推荐流。
 * 自动提取本地已登录账号凭证（Cookie）请求官方个性化电台，未登录时平滑降级至公共随心听电台流。
 * 点按直接播放，自动提取首曲专辑高清封面，卸载时完整还原宿主内部状态。
 *
 * 内部状态修改说明：
 * - 劫持函数：omni.getPersonalFm（在 providerId === 'qq' 时拉取电台 99 猜你喜欢个性化流）
 * - 修改能力：omni.getProviderCapabilities('qq').recommendations 置为 true
 * - 凭据使用：读取宿主本地保存的 QQ 音乐 Cookie 仅用于向腾讯官方接口鉴权，绝不上传任何外部服务器
 * - 卸载行为：恢复 omni.getPersonalFm 为原始引用，还原 capabilities.recommendations 为原值
 */

const QQ_ALBUM_COVER_BASE = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000';

function getAlbumCoverUrl(albumMid) {
  return albumMid ? `${QQ_ALBUM_COVER_BASE}${albumMid}.jpg?max_age=2592000` : undefined;
}

function normalizeTrackToUnifiedSong(raw) {
  const songMid = String(raw.mid || raw.songmid || '').trim();
  const rawSongId = raw.id || raw.songid;
  const numericSongId = Number(rawSongId);
  const songId = Number.isFinite(numericSongId) && numericSongId > 0 ? numericSongId : songMid;

  const albumMid = String(raw.album?.mid || raw.albummid || '').trim();
  const mediaMid = String(raw.file?.media_mid || raw.media_mid || songMid).trim();
  const coverUrl = getAlbumCoverUrl(albumMid);

  const singers = Array.isArray(raw.singer) ? raw.singer : Array.isArray(raw.singers) ? raw.singers : [];
  const artists = singers.map((s, idx) => ({
    id: s.mid || String(s.id || idx),
    name: String(s.name || s.title || '').trim(),
    ...(s.mid ? { catalogRef: { providerId: 'qq', kind: 'artist', id: s.mid } } : {}),
  })).filter(a => a.name);

  return {
    id: songId,
    name: String(raw.name || raw.title || raw.songname || 'Unknown Song').trim(),
    artists,
    album: {
      id: albumMid || raw.album?.id || '',
      name: String(raw.album?.name || raw.album?.title || '').trim(),
      ...(coverUrl ? { coverUrl } : {}),
      ...(albumMid ? { catalogRef: { providerId: 'qq', kind: 'album', id: albumMid } } : {}),
    },
    durationMs: Number.isFinite(Number(raw.interval)) ? Number(raw.interval) * 1000 : 0,
    ...(songMid ? { qqMid: songMid } : {}),
    sourceRef: {
      kind: 'online',
      providerId: 'qq',
      mediaId: songMid || String(songId),
      providerData: {
        songId,
        songMid,
        albumMid,
        mediaMid,
      },
    },
  };
}

export default function (folium) {
  const { omni } = folium.internals || {};
  if (!omni) {
    console.warn('[qq-radio-mod] folium.internals.omni 不可用');
    return;
  }

  // 1. 临时开启 QQ 音源 recommendations 能力标记，并记录原值
  const caps = omni.getProviderCapabilities?.('qq');
  const originalCapsRecommendations = caps ? caps.recommendations : false;
  if (caps) {
    caps.recommendations = true;
  }

  // 2. 读取本地存储的 QQ 音乐登录 Cookie
  function getQqCookie() {
    try {
      if (typeof localStorage !== 'undefined') {
        return (
          localStorage.getItem('online_provider:qq:cookie') ||
          localStorage.getItem('online_provider_qq_cookie') ||
          localStorage.getItem('qq_cookie') ||
          ''
        );
      }
    } catch {
      return '';
    }
    return '';
  }

  // 3. 拉取电台曲目（电台 99 为猜你喜欢，带鉴权拉取专属个性化流）
  async function fetchRadioTracks(radioId = 99, count = 15) {
    const payload = {
      comm: { ct: 24, cv: 0 },
      songlist: {
        module: 'mb_track_radio_svr',
        method: 'get_radio_track',
        param: {
          id: radioId,
          firstplay: 1,
          num: Math.min(15, count),
        },
      },
    };

    const targetUrl = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
    if (!folium.net?.fetch) {
      console.warn('[qq-radio-mod] folium.net.fetch 不可用');
      return [];
    }

    const cookie = getQqCookie();
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...(cookie ? {
        'Cookie': cookie,
        'X-Proxy-Cookie': cookie,
      } : {}),
    };

    try {
      const res = await folium.net.fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      const tracks = data?.songlist?.data?.tracks;
      if (Array.isArray(tracks) && tracks.length > 0) {
        return tracks.map(normalizeTrackToUnifiedSong);
      }
    } catch (err) {
      console.warn('[qq-radio-mod] fetchRadioTracks failed', radioId, err);
    }
    return [];
  }

  // 4. 记录并劫持 omni.getPersonalFm
  const originalGetPersonalFm = omni.getPersonalFm ? omni.getPersonalFm.bind(omni) : null;
  omni.getPersonalFm = async function (options) {
    const summary = omni.getActiveProviderSummary?.();
    if (summary?.providerId === 'qq') {
      try {
        // 核心：优先拉取电台 99（猜你喜欢），带登录态即为 100% 真实个性化推荐
        let songs = await fetchRadioTracks(99, 15);
        // 若未登录或返回为空，平滑降级到 101（随心听）或 199（热歌）
        if (!songs || songs.length === 0) {
          songs = await fetchRadioTracks(101, 15);
        }
        if (!songs || songs.length === 0) {
          songs = await fetchRadioTracks(199, 15);
        }
        if (songs && songs.length > 0) {
          return songs;
        }
      } catch (err) {
        console.warn('[qq-radio-mod] getPersonalFm failed, fallback to original', err);
      }
    }
    return originalGetPersonalFm ? originalGetPersonalFm(options) : [];
  };

  console.info('[qq-radio-mod] QQ 音乐个性化「猜你喜欢」电台推荐模组已激活');

  // 5. 卸载钩子：严谨还原所有内部状态
  return () => {
    if (originalGetPersonalFm) {
      omni.getPersonalFm = originalGetPersonalFm;
    }
    if (caps) {
      caps.recommendations = originalCapsRecommendations;
    }
    console.info('[qq-radio-mod] QQ 音乐个性化「猜你喜欢」模组已完整卸载并还原');
  };
}
