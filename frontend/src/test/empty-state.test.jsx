import { render, screen } from '@testing-library/react';
import { MemoryRouter, Link } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { EmptyState, ProfileRequired } from '../components/UI';

describe('EmptyState layout (audit Phase 6)', () => {
  it('renders link children after the paragraph, never inside it', () => {
    render(<MemoryRouter><EmptyState title="T">Some explanatory text.<Link to="/x" className="button">Go</Link></EmptyState></MemoryRouter>);
    const link = screen.getByRole('link', { name: /go/i });
    expect(link.closest('p')).toBeNull();
    expect(screen.getByText('Some explanatory text.').tagName).toBe('P');
  });
  it('keeps the profile-required prompt readable', () => {
    render(<MemoryRouter><ProfileRequired /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /set up profile/i }).closest('p')).toBeNull();
    expect(screen.getByText(/create a profile or open an existing one/i)).toBeTruthy();
  });
});
