import { useState } from 'react';
import { siteHref, type Site } from '../api';
import { StudioNavLeft } from '../components/StudioNavLeft';
import { SubPageChat, type SubPageChatMessage } from '../components/SubPageChat';
import { sitePage } from '../nav';
import './BlogPageStudio.css';

function blogListPreviewHref(site: Site): string {
  const locale = site.source_locale || site.locale_policy?.default_code || 'en';
  const prefix = site.locale_policy?.locales.find((item) => item.code === locale)?.prefix
    || locale.split('-')[0].toLowerCase();
  const path = `/${prefix}/blog`;
  const live = site.live_path?.replace(/\/+$/, '');
  return live ? `${live}${path}` : siteHref(site, path);
}

export default function BlogPageStudio({ site }: { site: Site }) {
  const [messages, setMessages] = useState<SubPageChatMessage[]>([]);
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewHref = blogListPreviewHref(site);

  function handleSend(text: string) {
    setMessages((prev) => [
      ...prev,
      { type: 'user', text },
      { type: 'ai', text: 'This version is just for reviewing the layout; generation will be wired in later.' },
    ]);
  }

  return (
    <div className="chat-detail-page">
      <div className="chat-detail-container">
        <div className="chat-main-layout">
          <div className="chat-detail-header">
            <StudioNavLeft
              title="New page"
              backTo={sitePage(site.id, 'page-settings')}
            />
          </div>
          <div className="ia-blueprint-layout ia-generating-wrapper">
            <div className="ia-generating-center">
              <div className="ia-gen-row">
                <div className="ia-gen-left">
                  <div className="ia-gen-left-body">
                    <SubPageChat
                      title="Edit page"
                      subtitle="Describe how you want the Blog list to look, and AI will update the preview on the right directly"
                      messages={messages}
                      placeholder="For example: make the headline card bigger and switch the articles to two columns…"
                      hint="Enter to send · Shift+Enter for a new line"
                      onSend={handleSend}
                    />
                  </div>
                </div>
                <div className="ia-gen-right">
                  <div className="ia-iframe-shell">
                    {previewHref && !previewFailed ? (
                      <iframe
                        src={previewHref}
                        title="Blog page preview"
                        className="ia-iframe"
                        onError={() => setPreviewFailed(true)}
                      />
                    ) : (
                      <div className="ia-iframe-empty">No preview yet</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
