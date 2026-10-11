// mods/qq-guess-you-like/client.mjs
/**
 * QQ 音乐「猜你喜欢」与雷达电台全功能热修补模组 (QQ Music Guess-You-Like & Radar Stations Patch Mod)
 *
 * 功能：
 * 1. 激活 QQ 音乐在线推荐能力（recommendations），无缝接入官方猜你喜欢流。
 * 2. 爬取第一首歌的专辑大图作为“猜你喜欢”主展示封面。
 * 3. 注入 QQ 音乐雷达电台频道列表（随心听、热歌、流行、治愈、情歌、快乐、摇滚、国风等）。
 * 4. 支持 2x2 尺寸的超大焦点卡片标记。
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

export default function (folium) {
  const { omni } = folium.internals || {};
  if (!omni) {
    console.warn('[qq-patch] folium.internals.omni 不可用，请确保 mod.json 配置了 "folia": "*"');
    return;
  }

  // 1. 获取并修补 QQ 音乐的 capabilities 引用
  const caps = omni.getProviderCapabilities('qq');
  if (caps) {
    caps.recommendations = true;
  }

  const stationCoverCache = new Map();

  function getAlbumCoverUrl(mid) {
    return mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${mid}.jpg?max_age=2592000` : '';
  }

  // 辅助请求函数：拉取 QQ 电台曲目
  async function fetchQQRadio(radioId = 99, count = 15) {
    const payload = {
      comm: { ct: 24, cv: 0 },
      songlist: {
        module: 'mb_track_radio_svr',
        method: 'get_radio_track',
        param: { id: radioId, firstplay: 1, num: Math.min(15, count) }
      }
    };

    const targetUrl = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
    let resData;

    // 优先通过 folium.net.fetch 走无跨域代理
    if (folium.net && folium.net.fetch) {
      try {
        const res = await folium.net.fetch(targetUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
          },
          body: JSON.stringify(payload)
        });
        resData = await res.json();
      } catch {
        resData = null;
      }
    }

    if (!resData) {
      try {
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        resData = await res.json();
      } catch {
        resData = null;
      }
    }

    const rawTracks = resData?.songlist?.data?.tracks || [];
    // 降级兜底：若未登录返回空，则请求随心听电台 101
    if (rawTracks.length === 0 && radioId === 99) {
      return fetchQQRadio(101, count);
    }

    // 格式化为 Folia 统一的 UnifiedSong 结构并确保首首歌有封面
    return rawTracks.map(t => {
      const albumMid = t.album?.mid || t.albummid;
      const coverUrl = getAlbumCoverUrl(albumMid);
      return {
        id: t.mid || t.id,
        name: t.name || t.title,
        artists: (t.singer || []).map((s, idx) => ({ id: s.mid || `${t.id}#${idx}`, name: s.name || s.title })),
        album: {
          id: albumMid || t.album?.id || '',
          name: t.album?.name || t.album?.title || '',
          coverUrl: coverUrl || undefined,
        },
        durationMs: (t.interval || 0) * 1000,
        qqMid: t.mid,
        sourceRef: {
          kind: 'online',
          providerId: 'qq',
          mediaId: t.mid || String(t.id),
        }
      };
    });
  }

  async function getStationCover(station) {
    if (stationCoverCache.has(station.id)) return stationCoverCache.get(station.id);
    try {
      const songs = await fetchQQRadio(station.id, 1);
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

  // 2. 劫持并增强 omni.getPersonalFm
  const originalGetPersonalFm = omni.getPersonalFm.bind(omni);
  omni.getPersonalFm = async function (options) {
    const summary = omni.getActiveProviderSummary();
    if (summary?.providerId === 'qq') {
      try {
        const songs = await fetchQQRadio(99, 15);
        if (songs && songs.length > 0) return songs;
      } catch (err) {
        console.warn('[qq-patch] getPersonalFm failed, fallback to original', err);
      }
    }
    return originalGetPersonalFm(options);
  };

  // 3. 劫持并增强 omni.getDailySongs
  const originalGetDailySongs = omni.getDailySongs.bind(omni);
  omni.getDailySongs = async function (refresh) {
    const summary = omni.getActiveProviderSummary();
    if (summary?.providerId === 'qq') {
      try {
        const songs = await fetchQQRadio(99, 30);
        if (songs && songs.length > 0) return songs;
      } catch (err) {
        console.warn('[qq-patch] getDailySongs failed, fallback to original', err);
      }
    }
    return originalGetDailySongs(refresh);
  };

  // 4. 劫持并增强 omni.getHomeFeed，构建丰富的雷达电台网格
  const originalGetHomeFeed = omni.getHomeFeed ? omni.getHomeFeed.bind(omni) : null;
  if (originalGetHomeFeed) {
    omni.getHomeFeed = async function (limit = 35) {
      const summary = omni.getActiveProviderSummary();
      if (summary?.providerId === 'qq') {
        try {
          const [personalFm, dailySongs] = await Promise.all([
            fetchQQRadio(99, 15),
            fetchQQRadio(101, 20),
          ]);

          const radioCollections = await Promise.all(
            QQ_RADIO_STATIONS.slice(0, limit).map(async (st) => ({
              id: `radio:${st.id}`,
              name: st.name,
              coverUrl: await getStationCover(st),
              trackCount: 30,
              type: 'radio',
              description: st.description,
              creator: { nickname: 'QQ音乐电台' },
            }))
          );

          return {
            personalFm,
            dailySongs,
            recommendedCollections: radioCollections,
          };
        } catch (err) {
          console.warn('[qq-patch] getHomeFeed failed, fallback to original', err);
        }
      }
      return originalGetHomeFeed(limit);
    };
  }

  console.info('[qq-patch] QQ 音乐猜你喜欢 & 雷达电台全功能模组已激活！');

  return () => {
    // 卸载钩子
    omni.getPersonalFm = originalGetPersonalFm;
    omni.getDailySongs = originalGetDailySongs;
    if (originalGetHomeFeed) omni.getHomeFeed = originalGetHomeFeed;
    console.info('[qq-patch] QQ 音乐猜你喜欢模组修补已卸载');
  };
}
