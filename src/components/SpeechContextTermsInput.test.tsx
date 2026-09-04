// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SpeechContextTermsInput } from './SpeechContextTermsInput';

afterEach(cleanup);

const LABEL = 'Sözlük terimleri';

/** Stateful wrapper so the controlled component reflects onChange in the DOM. */
function Harness({
  initial = [],
  maxTerms,
  maxTermLength,
  disabled,
}: {
  initial?: string[];
  maxTerms?: number;
  maxTermLength?: number;
  disabled?: boolean;
}) {
  const [terms, setTerms] = useState<string[]>(initial);
  return (
    <SpeechContextTermsInput
      terms={terms}
      onChange={setTerms}
      label={LABEL}
      maxTerms={maxTerms}
      maxTermLength={maxTermLength}
      disabled={disabled}
    />
  );
}

function getInput(): HTMLElement {
  return screen.getByRole('textbox', { name: LABEL });
}

function commit(value: string, key: 'Enter' | ',' = 'Enter'): void {
  const input = getInput();
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key });
}

describe('SpeechContextTermsInput', () => {
  it('adds a normalized chip on Enter and clears the draft', () => {
    render(<Harness />);
    commit('  Zeynep   Akkılıç  ');

    // Whitespace collapsed + trimmed — the chip is exactly what will persist.
    expect(screen.getByText('Zeynep Akkılıç')).toBeInTheDocument();
    expect(getInput()).toHaveValue('');
  });

  it('also commits on a comma keypress', () => {
    render(<Harness />);
    commit('OpenFGA', ',');
    expect(screen.getByText('OpenFGA')).toBeInTheDocument();
  });

  it('keeps case-distinct terms but rejects an exact duplicate with a hint', () => {
    render(<Harness />);
    commit('OpenFGA');
    commit('openfga'); // different case → a distinct spelling hint, allowed
    expect(screen.getByText('OpenFGA')).toBeInTheDocument();
    expect(screen.getByText('openfga')).toBeInTheDocument();

    commit('OpenFGA'); // exact duplicate → rejected
    expect(screen.getAllByText('OpenFGA')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('zaten ekli');
  });

  it('rejects a term longer than the character cap and does not add it', () => {
    render(<Harness maxTermLength={5} />);
    commit('123456'); // 6 chars > 5
    expect(screen.queryByText('123456')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('5 karakter');
  });

  it('removes the last chip on Backspace when the draft is empty', () => {
    render(<Harness initial={['Bir', 'İki']} />);
    const input = getInput();
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(screen.getByText('Bir')).toBeInTheDocument();
    expect(screen.queryByText('İki')).not.toBeInTheDocument();
  });

  it('removes a specific chip via its remove button', () => {
    render(<Harness initial={['Alfa', 'Beta']} />);
    fireEvent.click(screen.getByRole('button', { name: '"Alfa" terimini kaldır' }));
    expect(screen.queryByText('Alfa')).not.toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('disables the input at capacity and shows how many terms are allowed', () => {
    render(<Harness maxTerms={2} />);
    commit('Alfa');
    commit('Beta');
    const input = getInput();
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('placeholder', expect.stringContaining('2'));
    const chips = within(screen.getByRole('list', { name: 'Eklenen terimler' })).getAllByRole(
      'listitem',
    );
    expect(chips).toHaveLength(2);
  });

  it('commits multiple pasted terms split on newline/comma up to the cap', () => {
    render(<Harness maxTerms={3} />);
    const input = getInput();
    fireEvent.paste(input, {
      clipboardData: { getData: () => 'Alfa\nBeta, Alfa\nGama\nDelta' },
    });
    // Alfa deduped, capped at 3 → Alfa, Beta, Gama; Delta overflows.
    expect(screen.getByText('Alfa')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Gama')).toBeInTheDocument();
    expect(screen.queryByText('Delta')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('3 terim');
  });

  it('commits a pending draft on blur', () => {
    render(<Harness />);
    const input = getInput();
    fireEvent.change(input, { target: { value: 'Sergen Bediroğlu' } });
    fireEvent.blur(input);
    expect(screen.getByText('Sergen Bediroğlu')).toBeInTheDocument();
  });

  it('respects the disabled prop on chip removal', () => {
    const onChange = vi.fn();
    render(<SpeechContextTermsInput terms={['Alfa']} onChange={onChange} label={LABEL} disabled />);
    expect(screen.getByRole('button', { name: '"Alfa" terimini kaldır' })).toBeDisabled();
  });
});
