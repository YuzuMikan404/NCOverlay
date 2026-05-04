/**
 * ローカルファイル再生時のコメント描画
 *
 * ブラウザで file:// のURLを開いて動画を再生するときに
 * NCOverlayのコメント描画機能を有効にします。
 *
 * 動作:
 * 1. <video> 要素を検出する
 * 2. ファイル名からタイトルを取得し、自動検索を実行する
 * 3. コメントをオーバーレイ表示する
 *
 * ユーザーは手動でコメントファイルを追加することもできます
 * (サイドパネル/ポップアップの「ファイルから追加」ボタン)。
 */

import type { VodKey } from '@/types/constants'

import { defineContentScript } from '#imports'

import { MATCHES } from '@/constants/matches'
import { logger } from '@/utils/logger'
import { checkVodEnable } from '@/utils/extension/checkVodEnable'
import { NCOPatcher } from '@/ncoverlay/patcher'

const vod: VodKey = 'localFile'

/** 動画ファイルの拡張子 */
const VIDEO_EXTENSIONS =
  /\.(mp4|mkv|webm|avi|mov|m4v|ts|m2ts|flv|wmv|ogv|3gp|3g2)$/i

/** ファイルパスからファイル名(拡張子なし)を取得 */
function getFileTitle(src: string): string | null {
  try {
    const url = new URL(src)
    // file:// URL の場合
    if (url.protocol === 'file:') {
      const parts = url.pathname.split('/')
      const filename = decodeURIComponent(parts[parts.length - 1] ?? '')
      // 拡張子を除去
      return filename.replace(/\.[^.]+$/, '') || null
    }
    // blob: URL の場合はタイトルを取得できないのでnullを返す
    return null
  } catch {
    return null
  }
}

export default defineContentScript({
  matches: MATCHES[vod],
  runAt: 'document_end',
  main: () => void main(),
})

async function main() {
  if (!(await checkVodEnable(vod))) return

  logger.log('vod', vod)

  const patcher = new NCOPatcher(vod, {
    getInfo: async (nco) => {
      const src = nco.renderer.video.src || nco.renderer.video.currentSrc

      if (!src) return null

      // 動画ファイルでなければスキップ
      // (file:// の場合は拡張子で判定、blob: の場合はそのまま許可)
      if (src.startsWith('file://') && !VIDEO_EXTENSIONS.test(src)) {
        logger.log('Not a video file, skipping:', src)
        return null
      }

      const title = getFileTitle(src)
      const duration = nco.renderer.video.duration

      logger.log('localFile title:', title)
      logger.log('localFile duration:', duration)

      if (!title || !Number.isFinite(duration) || duration <= 0) {
        return null
      }

      return {
        input: title,
        duration,
      }
    },

    appendCanvas: (video, canvas) => {
      // Firefoxのローカル動画ページ (TopLevelVideoDocument) では
      // <body> を position:relative にすると動画レイアウトが壊れるため、
      // canvas を fixed 配置で動画の表示位置に合わせて重ねる。

      const syncCanvasToVideo = () => {
        const rect = video.getBoundingClientRect()
        canvas.style.position = 'fixed'
        canvas.style.top = `${rect.top}px`
        canvas.style.left = `${rect.left}px`
        canvas.style.width = `${rect.width}px`
        canvas.style.height = `${rect.height}px`
        canvas.style.pointerEvents = 'none'
        canvas.style.zIndex = '2147483647'
      }

      syncCanvasToVideo()
      document.body.appendChild(canvas)

      // ウィンドウリサイズ・フルスクリーン変化時に追従
      const ro = new ResizeObserver(syncCanvasToVideo)
      ro.observe(video)
      window.addEventListener('resize', syncCanvasToVideo)
      document.addEventListener('fullscreenchange', syncCanvasToVideo)
    },
  })

  // ページ内の <video> を検出する
  const obs_config: MutationObserverInit = {
    childList: true,
    subtree: true,
  }

  const trySetVideo = () => {
    if (patcher.nco) {
      // 既存のvideoが非表示になったら破棄
      if (!patcher.nco.renderer.video.checkVisibility()) {
        patcher.dispose()
      }
      return
    }

    // file:// ページはシンプルなので document.body 直下の video を探す
    const video = document.querySelector<HTMLVideoElement>('video')
    if (!video) return

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      // メタデータがすでにロード済み:
      // setVideo() で NCOPatcher の内部リスナーを先に登録してから
      // loadedmetadata を手動発火して loadInfo → autoSearch を起動する。
      patcher.setVideo(video).then(() => {
        patcher.nco?.dispatchEvent(new Event('loadedmetadata'))
      })
    } else {
      // メタデータ未ロード: 先に setVideo() して、あとは自然に
      // loadedmetadata が来るのを NCOPatcher 内部リスナーに任せる。
      patcher.setVideo(video)
    }
  }

  const obs = new MutationObserver(() => {
    obs.disconnect()
    trySetVideo()
    obs.observe(document.body, obs_config)
  })

  trySetVideo()
  obs.observe(document.body, obs_config)
}
