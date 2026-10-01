import type { SVGProps } from 'react';

/** Shared default document icon for files and notes in the notebook tree. */
export function NotebookTreeFileIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="64"
      height="64"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <g transform="matrix(0.6923077 0 0 0.6923077 0.6923077 0.6923077)">
        <line x1="7.6666" y1="11.36" x2="10.3333" y2="11.36" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        <line x1="7.6666" y1="15.18" x2="16.3333" y2="15.18" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        <path
          d="M 3.6667 19 V 5 c 0 -1.4733 1.1933 -2.6667 2.6667 -2.6667 h 7.448 c 0.3533 0 0.6933 0.14 0.9427 0.3907 l 5.2187 5.2187 c 0.2507 0.2507 0.3907 0.5893 0.3907 0.9427 v 10.1146 c 0 1.4733 -1.1933 2.6667 -2.6667 2.6667 H 6.3333 c -1.4733 0 -2.6667 -1.1933 -2.6667 -2.6667 Z"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d="M 20.2133 8.3333 h -4.5467 c -0.736 0 -1.3333 -0.5973 -1.3333 -1.3333 V 2.4693"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
  );
}
