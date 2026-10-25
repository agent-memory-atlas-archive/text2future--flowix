'use client';

import {
  BookOpen,
  ChartLine,
  Code2,
  FolderOpen,
  GraduationCap,
  Link2,
  PenLine,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

/**
 * 产品介绍的唯一内容源。
 *
 * 弹窗 (状态栏「产品介绍」按钮 / 首次启动) 与偏好设置 → 功能 → 产品介绍
 * 共用这里的数据与渲染，避免出现两份会各自漂移的文案列表。
 *
 * 新增一张卡片只需:
 *   1. 在 FEATURE_DEFINITIONS 里加一项 (key 即 i18n 键后缀);
 *   2. 在 messages.zh-CN.ts / messages.en-US.ts 补
 *      `productIntro.<key>.title` 与 `productIntro.<key>.description`。
 */
const FEATURE_DEFINITIONS = [
  { key: 'workspace', icon: BookOpen, caseStudy: false },
  { key: 'library', icon: FolderOpen, caseStudy: false },
  { key: 'links', icon: Link2, caseStudy: false },
  { key: 'pi', icon: Sparkles, caseStudy: false },
  { key: 'development', icon: Code2, caseStudy: true },
  { key: 'fiction', icon: PenLine, caseStudy: true },
  { key: 'investment', icon: ChartLine, caseStudy: true },
  { key: 'teaching', icon: GraduationCap, caseStudy: true },
] as const;

export type ProductIntroFeatureKey = (typeof FEATURE_DEFINITIONS)[number]['key'];

export interface ProductIntroFeature {
  key: ProductIntroFeatureKey;
  icon: LucideIcon;
  /** 真实使用场景示例 —— 卡片右上角追加「案例」徽章。 */
  caseStudy: boolean;
}

export const PRODUCT_INTRO_FEATURES: readonly ProductIntroFeature[] = FEATURE_DEFINITIONS;

/**
 * - `dialog`: 弹窗版式, 通栏 Hero + 双列大卡片。
 * - `panel`:  偏好设置版式, Hero 收成一张圆角卡片, 卡片更紧凑。
 */
export type ProductIntroLayout = 'dialog' | 'panel';

export interface ProductIntroContentProps {
  layout?: ProductIntroLayout;
  className?: string;
}

export function ProductIntroContent({ layout = 'dialog', className }: ProductIntroContentProps) {
  const { t } = useI18n();
  const panel = layout === 'panel';
  // 标题层级随宿主环境走: 弹窗 h2 带 h3 卡片, 设置面板 h3 带 h4 卡片。
  const Heading = panel ? 'h3' : 'h2';
  const CardHeading = panel ? 'h4' : 'h3';

  return (
    <div className={cn('flex flex-col', className)}>
      <div
        className={cn(
          'relative overflow-hidden bg-[linear-gradient(125deg,color-mix(in_oklch,var(--primary)_12%,var(--card)),var(--card)_58%)]',
          panel
            ? 'rounded-xl border border-[var(--border)] px-5 pb-5 pt-6'
            : 'px-7 pb-7 pt-8 sm:px-10 sm:pb-9 sm:pt-10',
        )}
      >
        <div aria-hidden="true" className="absolute -right-10 -top-20 h-64 w-64 rounded-full bg-[color-mix(in_oklch,var(--primary)_10%,transparent)] blur-3xl" />
        <div className="relative max-w-3xl">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[color-mix(in_oklch,var(--primary)_24%,var(--border))] bg-[color-mix(in_oklch,var(--primary)_7%,var(--card))] px-2 py-1.5 text-xs font-medium text-[var(--primary)]">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            {t('productIntro.eyebrow')}
          </div>
          <div className="space-y-3">
            <Heading
              className={cn(
                'font-semibold tracking-tight text-[var(--foreground)]',
                panel ? 'text-xl' : 'text-2xl sm:text-3xl',
              )}
            >
              {t('productIntro.title')}
            </Heading>
            <p
              className={cn(
                'max-w-2xl leading-6 text-[var(--muted-foreground)] sm:leading-7',
                panel ? 'text-sm' : 'text-sm sm:text-base',
              )}
            >
              {t('productIntro.description')}
            </p>
          </div>
        </div>
      </div>

      <div
        className={cn(
          'grid grid-cols-1 gap-3 sm:grid-cols-2',
          panel ? 'pt-4' : 'p-5 sm:gap-4 sm:p-7 lg:p-9',
        )}
      >
        {PRODUCT_INTRO_FEATURES.map((feature, index) => (
          <ProductIntroFeatureCard
            key={feature.key}
            feature={feature}
            index={index}
            layout={layout}
            headingTag={CardHeading}
          />
        ))}
      </div>

      <div className={cn(panel ? 'pt-4' : 'px-5 pb-6 sm:px-7 sm:pb-8 lg:px-9')}>
        <div className="flex items-center justify-center rounded-xl bg-[color-mix(in_oklch,var(--primary)_6%,var(--card))] px-4 py-3.5 text-center text-xs leading-5 text-[var(--muted-foreground)] sm:px-5 sm:text-sm">
          <span>{t('productIntro.footer')}</span>
        </div>
      </div>
    </div>
  );
}

function ProductIntroFeatureCard({
  feature,
  index,
  layout,
  headingTag: Heading,
}: {
  feature: ProductIntroFeature;
  index: number;
  layout: ProductIntroLayout;
  headingTag: 'h3' | 'h4';
}) {
  const { t } = useI18n();
  const panel = layout === 'panel';
  const { key, icon: Icon, caseStudy } = feature;

  return (
    <section
      className={cn(
        'group relative overflow-hidden rounded-xl border border-[var(--border)] bg-[color-mix(in_oklch,var(--background)_54%,var(--card))] transition-colors hover:bg-[color-mix(in_oklch,var(--primary)_3%,var(--card))]',
        panel ? 'p-4' : 'min-h-36 p-5 sm:p-6',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute right-4 select-none font-semibold tracking-tighter text-[color-mix(in_oklch,var(--muted-foreground)_8%,transparent)]',
          panel ? 'text-4xl' : 'text-5xl',
          caseStudy ? (panel ? 'top-11' : 'top-12') : 'top-2',
        )}
      >
        {String(index + 1).padStart(2, '0')}
      </span>
      {caseStudy && (
        <span className="absolute right-4 top-4 rounded-full border border-[color-mix(in_oklch,var(--primary)_24%,var(--border))] bg-[color-mix(in_oklch,var(--primary)_8%,var(--card))] px-2 py-0.5 text-[10px] font-medium text-[var(--primary)]">
          {t('productIntro.caseTag')}
        </span>
      )}
      <div className="relative">
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[color-mix(in_oklch,var(--primary)_10%,var(--card))] text-[var(--primary)]">
          <Icon className="h-5 w-5" strokeWidth={1.8} aria-hidden="true" />
        </div>
        <Heading className="text-sm font-semibold text-[var(--foreground)] sm:text-base">
          {t(`productIntro.${key}.title`)}
        </Heading>
        <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)] sm:text-sm sm:leading-6">
          {t(`productIntro.${key}.description`)}
        </p>
      </div>
    </section>
  );
}
