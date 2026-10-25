'use client';

import { ProductIntroContent } from '@features/product-intro';

/**
 * 偏好设置 → 功能 → 产品介绍。
 *
 * 内容与状态栏的「产品介绍」弹窗同源 (features/product-intro),
 * 这里用 panel 版式内联展示。
 */
export function ProductIntroSection() {
  return <ProductIntroContent layout="panel" />;
}
