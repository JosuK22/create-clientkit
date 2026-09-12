import { useEffect } from 'react';

/**
 * Keeps the document title and meta description in step with the current page.
 *
 * A single-page app renders its markup in the browser, so this runs after the
 * document loads rather than being baked into the HTML. That is enough for
 * bookmarks, tab titles and social crawlers that execute JavaScript, and it is
 * not enough for those that do not - a crawler that reads only the initial
 * response sees what is in index.html.
 *
 * If search visibility matters for the site you are building, that is a reason
 * to render on the server rather than a reason to add a library here.
 */
export function useDocumentMeta(title: string, description?: string): void {
  useEffect(() => {
    document.title = title;

    if (description === undefined || description === '') return;
    let tag = document.querySelector('meta[name="description"]');
    if (tag === null) {
      tag = document.createElement('meta');
      tag.setAttribute('name', 'description');
      document.head.appendChild(tag);
    }
    tag.setAttribute('content', description);
  }, [title, description]);
}
