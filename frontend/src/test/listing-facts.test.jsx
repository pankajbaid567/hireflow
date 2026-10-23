import {render,screen} from '@testing-library/react';
import {describe,expect,it} from 'vitest';
import ListingFacts from '../components/ListingFacts';
describe('evidence-backed listing information',()=>{
 it('does not replace unknown pay/experience/dates with zero',()=>{render(<ListingFacts job={{}}/>);expect(screen.getByText('Not disclosed')).toBeInTheDocument();expect(screen.getAllByText('Not stated')).toHaveLength(3);expect(screen.getByText(/not hiring probabilities/)).toBeInTheDocument();});
 it('keeps currency and period visible and distinguishes semantic fallback',()=>{render(<ListingFacts job={{compensation:{disclosed:true,currency:'INR',minimum:20000,maximum:30000,period:'month'},required_experience:{minimum_years:1,maximum_years:3},matching_method:'lexical',matching_state:'budget_limited'}}/>);expect(screen.getByText('INR 20,000–30,000 / month')).toBeInTheDocument();expect(screen.getByText('1–3 years')).toBeInTheDocument();expect(screen.getByText(/daily semantic allowance reached/)).toBeInTheDocument();});
 it('shows hybrid matching and verbatim process safely',()=>{render(<ListingFacts job={{matching_method:'hybrid',selection_process:['Technical interview then HR.','<script>never execute</script>']}}/>);expect(screen.getByText('Hybrid skill matching')).toBeInTheDocument();expect(screen.getByText('<script>never execute</script>')).toBeInTheDocument();expect(document.querySelector('script')).toBeNull();});
});
