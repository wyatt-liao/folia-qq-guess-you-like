// mods/qq-guess-you-like/client.mjs
/**
 * QQ 音乐个性化「猜你喜欢」与精选雷达电台矩阵模组 (全功能旗舰版)
 *
 * 核心特性：
 * 1. 【真实个性化推荐】：自动读取本地 QQ 音乐已登录账号 Cookie，直通腾讯官方个性化算法网关（电台 99），未登录自动平滑回退；
 * 2. 【首曲封面自动提取】：为“猜你喜欢”精准提取第 1 首曲目高清专辑大图（personalFmCoverUrl），告别默认空白；
 * 3. 【精选雷达电台矩阵】：注入 QQ 音乐 11 款热门雷达电台频道（随心听、热歌、流行、治愈、经典情歌等），带独立专属封面；
 * 4. 【电台卡片完整可打开】：接管 getPlaylistTracks / getCollectionTracks，电台卡片点入即可直接拉取并播放曲目；
 * 5. 【曲目契约严谨对齐】：符合宿主 normalizeQqSong 规约（数字 songId、完整 providerData）；
 * 6. 【纯净卸载】：完整还原 omni 劫持函数与 capabilities 能力标记。
 */

const QQ_RADIO_STATIONS = [
  { id: 101, name: '随心听', description: '随时随地，随心听你所爱', fallbackMid: '002hMaer3McPaG' },
  { id: 199, name: '热歌电台', description: '全网热歌流行风向标', fallbackMid: '003eUKqr3Ma2t8' },
  { id: 345, name: '流行音乐', description: '当下流行新潮旋律', fallbackMid: '004BT1Uj3qRht3' },
  { id: 673, name: '情感治愈站', description: '温暖治愈，抚平内心浮躁', fallbackMid: '002MEGbz2p4phB' },
  { id: 550, name: '经典情歌', description: '动人旋律，唱尽百态情深', fallbackMid: '002LBPoK4cE245' },
  { id: 140, name: '快乐节拍', description: '轻快明朗，唤醒快乐好心情', fallbackMid: '002BtbvR19JhQi' },
  { id: 130, name: '热血摇滚', description: '释放激情，感受摇滚灵魂', fallbackMid: '002X5NAN24f6TQ' },
  { id: 190, name: '中国风韵', description: '诗词入曲，国风戏腔经典', fallbackMid: '003eUKqr3Ma2t8' },
  { id: 307, name: '精选招牌歌', description: '百听不厌，殿堂招牌好歌', fallbackMid: '004QBIkj0B3YDj' },
  { id: 100, name: '跑步模式', description: '节奏带感，运动跑步必备', fallbackMid: '001fb8mt1DUCLS' },
  { id: 167, name: '网络流行', description: '全网爆款，短视频热门潮流', fallbackMid: '004edv9c2tKbvV' },
];

const QQ_ALBUM_COVER_BASE = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000';

function getAlbumCoverUrl(albumMid) {
  return albumMid ? `${QQ_ALBUM_COVER_BASE}${albumMid}.jpg?max_age=2592000` : '';
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

  // 1. 开启 QQ 音源 recommendations 能力标记
  const caps = omni.getProviderCapabilities?.('qq');
  const originalCapsRecommendations = caps ? caps.recommendations : false;
  if (caps) {
    caps.recommendations = true;
  }

  // 2. 读取本地存储中属于 QQ 音乐的鉴权 Cookie
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

  const stationCoverCache = new Map();

  // 3. 拉取电台曲目（电台 99 为猜你喜欢，带登录 Cookie 即为真实个性化推荐）
  async function fetchRadioTracks(radioId = 99, count = 15) {
    const payload = {
      comm: { ct: 24, cv: 0 },
      songlist: {
        module: 'mb_track_radio_svr',
        method: 'get_radio_track',
        param: {
          id: radioId,
          firstplay: 1,
          num: Math.min(20, Math.max(1, count)),
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

  async function getStationCover(station) {
    if (stationCoverCache.has(station.id)) return stationCoverCache.get(station.id);
    try {
      const songs = await fetchRadioTracks(station.id, 1);
      const cover = songs?.[0]?.album?.coverUrl;
      if (cover) {
        stationCoverCache.set(station.id, cover);
        return cover;
      }
    } catch {}
    const fallback = getAlbumCoverUrl(station.fallbackMid);
    stationCoverCache.set(station.id, fallback);
    return fallback;
  }

  // 4. 劫持 omni.getPersonalFm（优先电台 99 猜你喜欢，未登录平滑降级）
  const originalGetPersonalFm = omni.getPersonalFm ? omni.getPersonalFm.bind(omni) : null;
  omni.getPersonalFm = async function (options) {
    const summary = omni.getActiveProviderSummary?.();
    if (summary?.providerId === 'qq') {
      try {
        let songs = await fetchRadioTracks(99, 15);
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

  // 5. 劫持 omni.getDailySongs
  const originalGetDailySongs = omni.getDailySongs ? omni.getDailySongs.bind(omni) : null;
  if (originalGetDailySongs) {
    omni.getDailySongs = async function (refresh) {
      const summary = omni.getActiveProviderSummary?.();
      if (summary?.providerId === 'qq') {
        try {
          const songs = await fetchRadioTracks(99, 30);
          if (songs && songs.length > 0) return songs;
        } catch (err) {
          console.warn('[qq-radio-mod] getDailySongs failed, fallback', err);
        }
      }
      return originalGetDailySongs(refresh);
    };
  }

  // 6. 劫持 omni.getHomeFeed：注入猜你喜欢封面 (personalFmCoverUrl) 与 11 款精选电台网格
  const originalGetHomeFeed = omni.getHomeFeed ? omni.getHomeFeed.bind(omni) : null;
  if (originalGetHomeFeed) {
    omni.getHomeFeed = async function (limit = 35) {
      const summary = omni.getActiveProviderSummary?.();
      if (summary?.providerId === 'qq') {
        try {
          let personalFm = await fetchRadioTracks(99, 15);
          if (!personalFm || personalFm.length === 0) {
            personalFm = await fetchRadioTracks(101, 15);
          }
          const dailySongs = await fetchRadioTracks(101, 20);
          const personalFmCoverUrl = personalFm?.[0]?.album?.coverUrl || '';

          const radioCollections = await Promise.all(
            QQ_RADIO_STATIONS.slice(0, limit).map(async (st) => ({
              providerId: 'qq',
              id: `radio:${st.id}`,
              name: st.name,
              coverUrl: await getStationCover(st),
              trackCount: 30,
              type: 'radio',
              description: st.description,
              creator: { nickname: 'QQ音乐电台' },
              providerData: {
                stationId: st.id,
                isRadio: true,
              },
            }))
          );

          return {
            personalFm,
            personalFmCoverUrl,
            dailySongs,
            recommendedCollections: radioCollections,
          };
        } catch (err) {
          console.warn('[qq-radio-mod] getHomeFeed failed, fallback to original', err);
        }
      }
      return originalGetHomeFeed(limit);
    };
  }

  // 7. 接管电台歌单/集合点击：解决电台打不开的问题
  const originalGetPlaylistTracks = omni.getPlaylistTracks ? omni.getPlaylistTracks.bind(omni) : null;
  if (originalGetPlaylistTracks) {
    omni.getPlaylistTracks = async function (collectionId, options) {
      const idStr = String(typeof collectionId === 'object' ? collectionId?.id : collectionId);
      if (idStr.startsWith('radio:')) {
        const stationId = Number(idStr.replace(/^radio:/, '')) || 101;
        const tracks = await fetchRadioTracks(stationId, 30);
        return {
          items: tracks,
          total: Math.max(tracks.length, 30),
          hasMore: false,
          nextOffset: tracks.length,
        };
      }
      return originalGetPlaylistTracks(collectionId, options);
    };
  }

  const originalGetCollectionTracks = omni.getCollectionTracks ? omni.getCollectionTracks.bind(omni) : null;
  if (originalGetCollectionTracks) {
    omni.getCollectionTracks = async function (collection, options) {
      const idStr = String(typeof collection === 'object' ? collection?.id : collection);
      if (idStr.startsWith('radio:')) {
        const stationId = Number(idStr.replace(/^radio:/, '')) || 101;
        const tracks = await fetchRadioTracks(stationId, 30);
        return {
          items: tracks,
          total: Math.max(tracks.length, 30),
          hasMore: false,
          nextOffset: tracks.length,
        };
      }
      return originalGetCollectionTracks(collection, options);
    };
  }

  console.info('[qq-radio-mod] QQ 音乐个性化「猜你喜欢」与雷达电台矩阵全功能已激活！');

  // 8. 纯净卸载钩子
  return () => {
    if (originalGetPersonalFm) omni.getPersonalFm = originalGetPersonalFm;
    if (originalGetDailySongs) omni.getDailySongs = originalGetDailySongs;
    if (originalGetHomeFeed) omni.getHomeFeed = originalGetHomeFeed;
    if (originalGetPlaylistTracks) omni.getPlaylistTracks = originalGetPlaylistTracks;
    if (originalGetCollectionTracks) omni.getCollectionTracks = originalGetCollectionTracks;
    if (caps) caps.recommendations = originalCapsRecommendations;
    console.info('[qq-radio-mod] QQ 音乐个性化推荐与雷达电台模组已完整卸载并还原');
  };
}
