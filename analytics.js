// Single GA4 property for wajaildata.org and every recordwatch.github.io county
// monitor. content_group splits traffic per site in GA reports.
export const GA_MEASUREMENT_ID = 'G-LD86GBGC48';

export function gaHead(contentGroup = 'hub') {
  return `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA_MEASUREMENT_ID}', { content_group: '${contentGroup}' });
</script>`;
}
