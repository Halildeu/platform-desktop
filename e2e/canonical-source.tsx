import { createRoot } from 'react-dom/client';
import { SummaryPanel } from '../src/components/SummaryPanel';
import '../src/styles/global.css';

createRoot(document.getElementById('root')!).render(
  <SummaryPanel
    intelligence={{
      meetingId: '33333333-3333-4333-8333-333333333333',
      sessionId: '66666666-6666-4666-8666-666666666666',
      status: 'ready',
      error: null,
      result: {
        analysisRunId: '55555555-5555-4555-8555-555555555555',
        canonicalSessionId: '66666666-6666-4666-8666-666666666666',
        storageMode: 'canonical',
        generatedAtMs: 1789046984720,
        summaryMarkdown: 'Synthetic acceptance fixture.',
        citationCoverage: 1,
        decisions: [
          {
            id: 'decision-1',
            title: 'Test plan approved.',
            status: 'proposed',
            citations: [
              {
                segmentId: 'meeting-ai:0',
                sourceIndex: 0,
                sourceHash: '793aedef586413ef705212124d30bfea6201f835810d356ccf42b317c33e2391',
                startedAtMs: 1789046520809,
              },
            ],
          },
        ],
        actionItems: [],
      },
    }}
    canonicalResultStatus="ready"
  />,
);
