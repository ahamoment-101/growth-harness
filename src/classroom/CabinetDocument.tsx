import type { ReactNode } from 'react';
import type { CabinetDocument as DocumentItem } from '../../shared/cabinet-document';
import { formatDateTime } from '../api';
import { MarkdownDocument } from '../components/MarkdownDocument';
import './panels.css';

export function CabinetDocumentDetail({ document: doc, children }: { document: DocumentItem; children?: ReactNode }) {
  return <article className="room-document"><header><span>{doc.category} · {doc.locale} · {doc.version ? `v${doc.version}` : 'To be filled in'}</span><h2>{doc.title}</h2>{doc.date ? <small>{formatDateTime(doc.date)}</small> : null}</header>{children}{doc.body.trim() ? <MarkdownDocument markdown={doc.body} /> : <p className="room-empty">The document has not been filled in yet.</p>}</article>;
}

export function CabinetFileList({ documents, onOpen }: { documents: DocumentItem[]; onOpen: (id: string) => void }) {
  return <div className="room-file-grid">{documents.map(doc => <button type="button" className="room-file" key={doc.id} onClick={() => onOpen(doc.id)}><span className="room-file-paper" aria-hidden="true"><i /><i /><i /><i /></span><span className="room-file-category">{doc.category}</span><h2>{doc.title}</h2><p>{doc.locale} · {doc.version ? `v${doc.version}` : 'To be filled in'}</p><footer>{doc.date ? formatDateTime(doc.date) : 'Not yet updated'}<span>Open ↗</span></footer></button>)}</div>;
}
