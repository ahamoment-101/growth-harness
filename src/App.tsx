import { useEffect, useState } from 'react';
import { api, type AuthState, type Site } from './api';
import ContentArticle from './pages/ContentArticle';
import ContentGroupDetail from './pages/ContentGroupDetail';
import ContentList from './pages/ContentList';
import Keywords from './pages/Keywords';
import KeywordTopic from './pages/KeywordTopic';
import Settings from './pages/Settings';
import ProjectSettings from './pages/ProjectSettings';
import PageSettings from './pages/PageSettings';
import BlogPageStudio from './pages/BlogPageStudio';
import Sites from './pages/Sites';
import Seo from './pages/Seo';
import Triggers from './pages/Triggers';
import Classroom from './classroom/Classroom';
import { ActivityPanel } from './classroom/ActivityPanel';
import { CabinetPanel } from './classroom/CabinetPanel';
import { ClassroomWindow } from './classroom/ClassroomWindow';
import { businessModuleByPage } from '../shared/business';
import { agentPage, go, parseRoute, usePath } from './nav';
import Login from './pages/Login';
import Account from './pages/Account';
import { redirectToLogin } from './auth-session';

export default function App() {
  const path = usePath();
  const route = parseRoute(path);
  const [sites, setSites] = useState<Site[]>([]);
  const [err, setErr] = useState('');
  const [auth, setAuth] = useState<AuthState | null>(null);

  const [ready, setReady] = useState(false);

  async function reload() {
    const d = await api.sites();
    setSites(d.sites);
  }

  function patchSite(next: Site) {
    setSites((xs) => xs.map((s) => (s.id === next.id ? next : s)));
  }

  useEffect(() => {
    api.authState()
      .then(async (state) => {
        setAuth(state);
        if (state.authenticated) await reload();
        else redirectToLogin();
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setReady(true));
  }, []);

  // After GSC OAuth callback, the redirect includes ?gsc=connected — reload site data and clean URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('gsc') || params.has('gsc_error')) {
      reload().catch((e: Error) => setErr(e.message));
      params.delete('gsc');
      params.delete('gsc_error');
      const clean = params.toString();
      const base = window.location.pathname;
      window.history.replaceState(null, '', clean ? `${base}?${clean}` : base);
    }
  }, [path]);

  useEffect(() => {
    const oldReview = /^\/website\/([^/]+)\/review\/([^/]+)\/?$/.exec(path);
    if (oldReview) { go(agentPage(oldReview[1], 'content_production', oldReview[2]), 'replace'); return; }
    const oldAgent = /^\/website\/([^/]+)\/(strategy|topics|articles|review)\/?$/.exec(path);
    if (oldAgent) {
      const ids: Record<string, string> = { strategy: 'strategy_research', topics: 'topic_decision', articles: 'content_production', review: 'content_production' };
      go(agentPage(oldAgent[1], ids[oldAgent[2]]), 'replace');
      return;
    }
    const legacy = /^\/s\/(.*)$/.exec(path);
    if (legacy) {
      go(`/website/${legacy[1]}`, 'replace');
      return;
    }
  }, [path, ready, route.page, sites]);

  if (!ready) {
    return (
      <div className="app">
        <p className="empty">Loading…</p>
      </div>
    );
  }

  if (path === '/login' || !auth?.authenticated) {
    return <Login auth={auth} error={err} />;
  }
  if (path === '/account') return <Account auth={auth} />;

  if (route.page === 'sites') {
    return <Sites sites={sites} onChange={() => reload().catch((e: Error) => setErr(e.message))} err={err} />;
  }

  const site = sites.find((s) => s.id === route.siteId) || null;
  if (!site) {
    return <Sites sites={sites} onChange={() => reload().catch((e: Error) => setErr(e.message))} err={err || 'Site not found'} />;
  }

  return (
    <div className="classroom-workspace" key={site.id}>
      <div className="classroom-background" inert={route.page !== 'classroom'}>
        <Classroom site={site} sites={sites} active={route.page === 'classroom'} openAgentId={route.page === 'classroom' ? new URLSearchParams(location.search).get('agent') : null} openReviewJobId={route.page === 'classroom' ? new URLSearchParams(location.search).get('review') : null} openConversationId={route.page === 'classroom' ? new URLSearchParams(location.search).get('conversation') : null} openTaskId={route.page === 'classroom' ? new URLSearchParams(location.search).get('task') : null} />
      </div>
      {route.page !== 'classroom' ? (
        <ClassroomWindow site={site} title={route.page === 'room-activity' ? 'Goals and Results' : route.page === 'cabinet' || businessModuleByPage(route.page) ? 'File Cabinet' : undefined}>{renderPanel()}</ClassroomWindow>
      ) : null}
    </div>
  );

  function renderPanel() {
    if (!site) return null;
    if (route.page === 'room-activity') return <ActivityPanel key={site.id} siteId={site.id} />;
    if (route.page === 'cabinet') return <CabinetPanel key={site.id + path} site={site} initialCategory={/\/(business|business-model)\/?$/.test(path) ? 'Business Profile' : undefined} />;
    if (route.page === 'keyword-topic') return <KeywordTopic key={site.id + route.topicId + location.search} site={site} sites={sites} topicId={route.topicId} />;
    if (route.page === 'page-studio') {
      return <BlogPageStudio key={site.id} site={site} />;
    }
    if (route.page === 'content-group-detail') {
      return <ContentGroupDetail key={route.groupId} site={site} sites={sites} groupId={route.groupId} />;
    }
    if (route.page === 'content-article') {
      return <ContentArticle key={route.jobId} site={site} sites={sites} jobId={route.jobId} />;
    }
    const businessDefinition = businessModuleByPage(route.page);
    if (businessDefinition) {
      return <CabinetPanel key={`${site.id}-${businessDefinition.key}`} site={site} initialCategory="Business Profile" initialModule={businessDefinition.key} />;
    }
    if (route.page === 'content-list') return <ContentList key={site.id} site={site} sites={sites} />;
    if (route.page === 'settings') {
      return (
        <Settings
          key={site.id}
          site={site}
          sites={sites}
          onSaved={() => reload().catch((e: Error) => setErr(e.message))}
          onSitePatch={patchSite}
        />
      );
    }
    if (route.page === 'project-settings') {
      return <ProjectSettings key={site.id} site={site} sites={sites} onSitePatch={patchSite} />;
    }
    if (route.page === 'seo' || route.page === 'analytics') return <Seo key={site.id} site={site} sites={sites} />;
    if (route.page === 'triggers') return <Triggers key={site.id} site={site} sites={sites} />;
    if (route.page === 'page-settings') {
      return <PageSettings key={site.id} site={site} sites={sites} onSitePatch={patchSite} />;
    }
    if (route.page === 'keywords') return <Keywords key={site.id} site={site} sites={sites} />;
    return <ContentList key={site.id} site={site} sites={sites} />;
  }
}
