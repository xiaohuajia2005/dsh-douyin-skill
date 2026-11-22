// ============================================================
// 证据层 · 指纹族（迭代 7 从 chat-message.mjs 原样抽出）
//
// 指纹只覆盖"消息内容本身"：展示时间不参与（会变）、DOM 选择器不参与（会变）、
// 分享卡片的异步封面不参与（加载中会变），但分享卡片的身份字段必须参与。
// 这一层的任何改动都直接等于"水位是否认得旧消息"，改前必须先动 tests/evidence.test.mjs。
// ============================================================
import { createHash } from 'node:crypto';

// 展示时间和 DOM 选择器会变化；核对真正的消息内容及媒体资源。
export function messageFingerprint(message) {
  const media=message.media;
  // 分享卡片的封面与资源引用是异步加载的，只把稳定身份算进指纹，避免正常加载被二次核对误判成“消息被改动”。
  const mediaValue=media ? (media.type==='shared-work' ? {
    type:media.type,videoId:media.videoId,url:media.url,isPhotoGallery:media.isPhotoGallery,
  } : {
    type:media.type,label:media.label,title:media.title,author:media.author,durationSeconds:media.durationSeconds,
    videoId:media.videoId,url:media.url,isPhotoGallery:media.isPhotoGallery,
    domain:media.domain,contentStatus:media.contentStatus,imageMd5:media.imageMd5,...(media.animatedHint ? {animatedHint:true} : {}),
    resources:media.resources?.map(resource=>({resourceRef:resource.resourceRef,label:resource.label})),
  }) : null;
  const value=[message.sender||message.direction,message.kind||'text',message.text||'',mediaValue];
  if (message.reference) value.push({ reference: { text: message.reference.text, scope: message.reference.scope } });
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export const messageContent = messages => messages.map(message => ({ id: message.id, fingerprint: messageFingerprint(message) }));
