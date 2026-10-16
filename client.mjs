// mods/qq-guess-you-like/client.mjs
/**
 * QQ 音乐精选雷达电台与随心听增强模组 (QQ Music Radar & Stream Mod)
 *
 * 功能说明：
 * 基于 Folium internals 为 QQ 音乐音源接入「随心听」与 11 款精选热门雷达电台矩阵。
 * 1. 接入随心听公共电台流（电台 101，自动降级至 199），第一首歌高清封面由宿主自动提取展示；
 * 2. 注入 11 款热门雷达电台网格，采用静态高清专辑封面，零额外首屏网络请求；
 * 3. 通过 omni.getCollectionTracks 接管电台点击，点入直接拉取并播放 30 首电台曲目；
 * 4. 严谨对齐宿主 normalizeQqSong 规约（数字 songId、完整 providerData、无多余 fallback）；
 * 5. 安全合规：纯匿名请求腾讯公开接口，不读取或发送任何用户凭证，不执行远程代码；
 * 6. 纯净卸载：完整还原所有被替换的内部函数与能力标记。
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
  // 严格对齐宿主 normalizeQqSong：没有 mediaMid 时保持空字符串，不回退到 songMid
  const mediaMid = String(raw.file?.media_mid || raw.media_mid || '').trim();
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

  // 1. 开启 QQ 音源 recommendations 能力标记，并记录原值
  const caps = omni.getProviderCapabilities?.('qq');
  const originalCapsRecommendations = caps ? caps.recommendations : false;
  if (caps) {
    caps.recommendations = true;
  }

  // 2. 匿名请求公开电台曲目（通过主进程 folium.net.fetch，杜绝凭证泄漏）
  async function fetchRadioTracks(radioId = 101, count = 15) {
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

    try {
      const res = await folium.net.fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
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

  // 3. 劫持 omni.getPersonalFm（优先拉取随心听 101，若空则回退至热歌 199）
  const originalGetPersonalFm = omni.getPersonalFm ? omni.getPersonalFm.bind(omni) : null;
  omni.getPersonalFm = async function (options) {
    const summary = omni.getActiveProviderSummary?.();
    if (summary?.providerId === 'qq') {
      try {
        let songs = await fetchRadioTracks(101, 15);
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

  // 4. 劫持 omni.getHomeFeed：为电台页注入随心听曲目与 11 款雷达电台网格
  const originalGetHomeFeed = omni.getHomeFeed ? omni.getHomeFeed.bind(omni) : null;
  if (originalGetHomeFeed) {
    omni.getHomeFeed = async function (limit = 35) {
      const summary = omni.getActiveProviderSummary?.();
      if (summary?.providerId === 'qq') {
        try {
          // 只请求一次随心听（宿主自动取第 1 首封面渲染展示），无多余冗余请求
          let personalFm = await fetchRadioTracks(101, 15);
          if (!personalFm || personalFm.length === 0) {
            personalFm = await fetchRadioTracks(199, 15);
          }

          // 电台网格采用静态高质量封面，零额外网络请求，秒级渲染
          const radioCollections = QQ_RADIO_STATIONS.slice(0, limit).map((st) => ({
            providerId: 'qq',
            id: `radio:${st.id}`,
            name: st.name,
            coverUrl: getAlbumCoverUrl(st.fallbackMid),
            trackCount: 30,
            type: 'radio',
            description: st.description,
            creator: { nickname: 'QQ音乐电台' },
            providerData: {
              stationId: st.id,
              isRadio: true,
            },
          }));

          return {
            personalFm,
            recommendedCollections: radioCollections,
          };
        } catch (err) {
          console.warn('[qq-radio-mod] getHomeFeed failed, fallback to original', err);
        }
      }
      return originalGetHomeFeed(limit);
    };
  }

  // 5. 接管电台歌单/集合点击（omni.getCollectionTracks），实现电台点入即播
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

  console.info('[qq-radio-mod] QQ 音乐随心听与雷达电台矩阵模组已激活！');

  // 6. 纯净卸载钩子：100% 还原所有内部引用与能力标记
  return () => {
    if (originalGetPersonalFm) omni.getPersonalFm = originalGetPersonalFm;
    if (originalGetHomeFeed) omni.getHomeFeed = originalGetHomeFeed;
    if (originalGetCollectionTracks) omni.getCollectionTracks = originalGetCollectionTracks;
    if (caps) caps.recommendations = originalCapsRecommendations;
    console.info('[qq-radio-mod] QQ 音乐电台模组已完整卸载并还原');
  };
}
