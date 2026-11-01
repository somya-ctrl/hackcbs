import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { 
  ArrowLeft, 
  MapPin, 
  AlertTriangle, 
  Users, 
  Clock, 
  Tag, 
  Building2, 
  CheckCircle2, 
  ThumbsUp, 
  MessageSquare, 
  Send, 
  ShieldCheck, 
  Sparkles,
  FileText,
  ImageOff,
  GraduationCap,
  Briefcase,
  Lock,
  ExternalLink,
  Video,
  Check,
  RefreshCw
} from 'lucide-react';

// Fix for default marker icon in react-leaflet
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const ProblemDetail = () => {
  const { id } = useParams<{ id: string }>();
  const [problem, setProblem] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hasUpvoted, setHasUpvoted] = useState(false);
  const [upvotesCount, setUpvotesCount] = useState(0);
  
  // Real backend comments state
  const [comments, setComments] = useState<any[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [newComment, setNewComment] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);

  // College Matcher triggering state
  const [matchingColleges, setMatchingColleges] = useState(false);
  const [collegeMatchError, setCollegeMatchError] = useState<string | null>(null);
  
  const navigate = useNavigate();
  const user = JSON.parse(localStorage.getItem('user') || '{}');

  useEffect(() => {
    const fetchProblemAndComments = async () => {
      try {
        const token = localStorage.getItem('accessToken');
        if (!token) {
          navigate('/login');
          return;
        }
        
        // Fetch problem details via GET /api/problems/:id
        const response = await fetch(`https://hackcbs-cjno.onrender.com/api/problems/${id}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.status === 401) {
          localStorage.removeItem('accessToken');
          localStorage.removeItem('user');
          navigate('/login');
          return;
        }

        if (!response.ok) throw new Error('Failed to fetch problem details');
        
        const data = await response.json();
        const p = data.data;
        setProblem(p);
        
        // Backend upvotes
        const backendUpvotes = p.upvotesCount ?? (Array.isArray(p.upvotedBy) ? p.upvotedBy.length : 0);
        setUpvotesCount(backendUpvotes);
        setHasUpvoted(Array.isArray(p.upvotedBy) && p.upvotedBy.includes(user._id || user.id));

        // Auto-fetch matched colleges via Hugging Face model if not present on problem
        if (!p.collegeSuggestions || (Array.isArray(p.collegeSuggestions) && p.collegeSuggestions.length === 0)) {
          try {
            const collegeRes = await fetch(`https://hackcbs-cjno.onrender.com/api/problems/${id}/matched-colleges`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            if (collegeRes.ok) {
              const collegeData = await collegeRes.json();
              if (Array.isArray(collegeData.data) && collegeData.data.length > 0) {
                p.collegeSuggestions = collegeData.data;
                setProblem((prev: any) => prev ? { ...prev, collegeSuggestions: collegeData.data } : prev);
              }
            }
          } catch (cErr) {
            console.warn('Could not auto-fetch matched colleges:', cErr);
          }
        }

        // Fetch real comments from backend
        try {
          const commentsRes = await fetch(`https://hackcbs-cjno.onrender.com/api/problems/${id}/comments`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
          if (commentsRes.ok) {
            const commentsData = await commentsRes.json();
            setComments(commentsData.data || []);
          }
        } catch (commentErr) {
          console.error('Failed to fetch comments', commentErr);
        } finally {
          setCommentsLoading(false);
        }

      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchProblemAndComments();
  }, [id, navigate, user._id, user.id]);

  const handleTriggerCollegeMatching = async () => {
    if (matchingColleges) return;
    setMatchingColleges(true);
    setCollegeMatchError(null);
    try {
      const token = localStorage.getItem('accessToken');
      if (!token) {
        navigate('/login');
        return;
      }
      const res = await fetch(`https://hackcbs-cjno.onrender.com/api/problems/${id}/matched-colleges?refresh=true`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const resData = await res.json();
      if (res.ok && Array.isArray(resData.data) && resData.data.length > 0) {
        setProblem((prev: any) => ({ ...prev, collegeSuggestions: resData.data }));
      } else {
        setCollegeMatchError(resData.message || 'Could not fetch matched colleges from Hugging Face model.');
      }
    } catch (err: any) {
      setCollegeMatchError(err.message || 'Failed to connect to college matcher service.');
    } finally {
      setMatchingColleges(false);
    }
  };

  const handleToggleUpvote = async () => {
    const nextUpvoted = !hasUpvoted;
    setHasUpvoted(nextUpvoted);
    setUpvotesCount(prev => Math.max(0, prev + (nextUpvoted ? 1 : -1)));

    try {
      const token = localStorage.getItem('accessToken');
      if (token && id) {
        const res = await fetch(`https://hackcbs-cjno.onrender.com/api/problems/${id}/upvote`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          const resData = await res.json();
          if (resData.data) {
            setUpvotesCount(resData.data.upvotesCount ?? (Array.isArray(resData.data.upvotedBy) ? resData.data.upvotedBy.length : upvotesCount));
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim() || submittingComment) return;

    setSubmittingComment(true);
    try {
      const token = localStorage.getItem('accessToken');
      if (!token) {
        navigate('/login');
        return;
      }

      const res = await fetch(`https://hackcbs-cjno.onrender.com/api/problems/${id}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ text: newComment.trim() })
      });

      if (res.ok) {
        const resData = await res.json();
        if (resData.data) {
          setComments(prev => [resData.data, ...prev]);
          setNewComment('');
        }
      }
    } catch (err) {
      console.error('Failed to post comment', err);
    } finally {
      setSubmittingComment(false);
    }
  };

  const getSeverityColor = (severity: string) => {
    switch(severity?.toLowerCase()) {
      case 'critical': return 'bg-red-100 text-red-800 border-red-200';
      case 'high': return 'bg-orange-100 text-orange-800 border-orange-200';
      case 'medium': return 'bg-amber-100 text-amber-800 border-amber-200';
      default: return 'bg-[#4a6b4e]/10 text-[#4a6b4e] border-[#4a6b4e]/20';
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#f4f1e1] text-[#2c4230] font-sans">
        <Sparkles className="animate-spin text-[#4a6b4e] mr-2" /> Loading challenge tracking details...
      </div>
    );
  }

  if (error || !problem) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#f4f1e1] text-red-700 font-sans p-6">
        <div className="bg-white p-8 rounded-3xl border border-red-200 max-w-md text-center shadow-md">
          <AlertTriangle className="mx-auto text-red-600 mb-3" size={36} />
          <h3 className="text-lg font-bold mb-2">Failed to load problem</h3>
          <p className="text-xs text-red-600 mb-4">{error || 'Problem not found'}</p>
          <Link to="/feed" className="px-4 py-2 bg-[#2c4230] text-[#f4f1e1] rounded-xl text-xs font-bold">
            Back to Public Feed
          </Link>
        </div>
      </div>
    );
  }

  // University assigned strictly from backend
  const assignedUniversityName = 
    problem.acceptedByUniversityName ||
    problem.acceptedBy?.profileDetails?.institutionName ||
    problem.acceptedBy?.name ||
    problem.acceptedBy?.universityName ||
    null;

  const team = problem.team || null;
  const solution = team?.solution || problem.solution || null;
  const hasSolution = !!(
    (solution && (solution.description || solution.docxLink || solution.demoVideoLink || solution.prototypeLink || solution.submittedAt)) ||
    ['PROTOTYPE', 'VALIDATED', 'DEPLOYED', 'RESOLVED'].includes(problem.status) ||
    problem.isSolutionSubmitted
  );

  // Determine stage flags
  const isProblemAccepted = !!(assignedUniversityName || problem.status === 'ACCEPTED' || ['IN_PROGRESS', 'PROPOSAL', 'PROTOTYPE', 'VALIDATED', 'DEPLOYED'].includes(problem.status));
  const isTeamFormed = !!(team || ['IN_PROGRESS', 'PROPOSAL', 'PROTOTYPE', 'VALIDATED', 'DEPLOYED'].includes(problem.status));
  const isSolutionSubmitted = hasSolution;

  const rawColleges = problem.collegeSuggestions || problem.college_suggestions || problem.aiAnalysis?.collegeSuggestions || problem.aiAnalysis?.matchedColleges || problem.matchedColleges || [];
  const collegeSuggestions = Array.isArray(rawColleges)
    ? rawColleges
    : (typeof rawColleges === 'string' ? JSON.parse(rawColleges) : []);
  const rawCompanies = problem.companySuggestions || problem.company_suggestions || problem.aiAnalysis?.companySuggestions || problem.aiAnalysis?.matchedCompanies || problem.matchedCompanies || [];
  const companySuggestions = Array.isArray(rawCompanies)
    ? rawCompanies
    : (typeof rawCompanies === 'string' ? JSON.parse(rawCompanies) : []);

  const lat = problem.location?.latitude || problem.location?.coordinates?.latitude || 23.3441;
  const lng = problem.location?.longitude || problem.location?.coordinates?.longitude || 85.3096;

  const validMedia = Array.isArray(problem.imagesAndMedia)
    ? problem.imagesAndMedia.filter((m: any) => m && m.url && typeof m.url === 'string' && !m.url.includes('placeholder.com'))
    : [];

  return (
    <div className="flex h-screen w-screen bg-[#f4f1e1] font-sans text-[#2c4230] overflow-hidden">
      <Sidebar />

      <main className="flex-1 flex flex-col overflow-y-auto relative bg-[#f4f1e1]">
        {/* Top Header */}
        <header className="sticky top-0 z-20 bg-white/95 backdrop-blur-md border-b border-[#e2ded0] px-8 py-4 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate(-1)} className="p-2 hover:bg-[#f4f1e1] rounded-full transition-colors text-[#2c4230]">
              <ArrowLeft size={20} />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-extrabold text-[#2c4230]">Challenge & Solution Lifecycle Tracker</h2>
                <span className="px-2.5 py-0.5 bg-[#4a6b4e]/15 text-[#2c4230] text-[11px] font-bold rounded-md uppercase font-mono">
                  {problem.status || 'ACTIVE'}
                </span>
              </div>
              <p className="text-xs text-[#556958]">ID: #{(problem.id || problem._id)?.substring(0, 12)}</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button 
              onClick={handleToggleUpvote}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-bold transition-all ${
                hasUpvoted 
                  ? 'bg-[#2c4230] text-[#f4f1e1] shadow-sm' 
                  : 'bg-[#f4f1e1] text-[#2c4230] hover:bg-[#e2ded0] border border-[#e2ded0]'
              }`}
            >
              <ThumbsUp size={14} className={hasUpvoted ? 'fill-current' : ''} />
              <span>{upvotesCount} Upvotes</span>
            </button>
            <Link 
              to="/university/dashboard"
              className="px-3.5 py-2 bg-white text-[#2c4230] border border-[#e2ded0] rounded-full text-xs font-bold hover:bg-[#f4f1e1] transition-all flex items-center gap-1.5 shadow-sm"
            >
              <GraduationCap size={14} className="text-[#4a6b4e]" /> University Dashboard
            </Link>
          </div>
        </header>

        <div className="p-8 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Main 2-Column Content */}
          <div className="lg:col-span-2 space-y-8">
            
            {/* Header Primary Card */}
            <section className="bg-white p-8 rounded-3xl border border-[#e2ded0] shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
              <div className="flex flex-wrap items-center gap-2.5 mb-4">
                <span className={`px-3 py-1 text-xs font-bold uppercase rounded-full border ${getSeverityColor(problem.aiAnalysis?.severity)}`}>
                  {problem.aiAnalysis?.severity || 'NORMAL'} SEVERITY
                </span>
                <span className="px-3 py-1 bg-[#4a6b4e]/10 text-[#2c4230] border border-[#4a6b4e]/20 text-xs font-bold rounded-full">
                  {problem.aiAnalysis?.problem_classification || 'Civic Problem'}
                </span>
                {assignedUniversityName && (
                  <span className="px-3 py-1 bg-emerald-100 text-emerald-800 border border-emerald-200 text-xs font-bold rounded-full flex items-center gap-1">
                    <CheckCircle2 size={13} /> Adopted by {assignedUniversityName}
                  </span>
                )}
              </div>
              
              <h1 className="text-2xl sm:text-3xl font-extrabold text-[#2c4230] mb-3 leading-tight">
                {problem.title || "Civic Challenge Statement"}
              </h1>
              
              <div className="flex flex-wrap items-center gap-6 text-xs text-[#556958] font-medium mb-6 pb-6 border-b border-[#e2ded0]">
                <span className="flex items-center gap-1.5">
                  <MapPin size={14} className="text-[#4a6b4e]" />
                  {problem.district || problem.location?.district || 'Central Delhi'}, {problem.state || problem.location?.state || 'Delhi'}
                  {problem.location?.village && ` • ${problem.location.village}`}
                </span>
                <span className="flex items-center gap-1.5">
                  <Clock size={14} className="text-[#4a6b4e]" /> {new Date(problem.createdAt || Date.now()).toLocaleDateString()}
                </span>
                <span className="flex items-center gap-1.5">
                  <Tag size={14} className="text-[#4a6b4e]" /> Submitter: {problem.submittedBy?.name || 'Local Citizen'}
                </span>
              </div>

              <div className="text-sm text-[#3e4a36] space-y-3">
                <h3 className="text-base font-bold text-[#2c4230]">Field Problem Statement</h3>
                <p className="whitespace-pre-wrap leading-relaxed text-[#4a5848] bg-[#f4f1e1]/40 p-4 rounded-2xl border border-[#e2ded0]/80">
                  {problem.description}
                </p>
              </div>
            </section>

            {/* VERTICAL SEQUENCE LIFECYCLE TRACKER */}
            <section className="bg-white p-8 rounded-3xl border border-[#e2ded0] shadow-[0_4px_20px_rgba(0,0,0,0.04)]">
              <div className="flex items-center justify-between mb-8 pb-4 border-b border-[#e2ded0]">
                <div>
                  <h3 className="text-lg font-extrabold text-[#2c4230] flex items-center gap-2">
                    <ShieldCheck className="text-[#4a6b4e]" size={22} /> Vertical Resolution Sequence
                  </h3>
                  <p className="text-xs text-[#556958] mt-0.5">
                    Step-by-step progress from college acceptance to team formation, solution lock, and industry commercialization.
                  </p>
                </div>
                <span className="text-xs font-bold text-[#4a6b4e] bg-[#4a6b4e]/10 px-3 py-1 rounded-full shrink-0">
                  {isSolutionSubmitted ? 'Solution Complete' : isTeamFormed ? 'Prototyping Phase' : isProblemAccepted ? 'Team Formation' : 'Pending Review'}
                </span>
              </div>

              {/* VERTICAL STEPS CONTAINER */}
              <div className="space-y-6">

                {/* STEP 1: PROBLEM ACCEPTED */}
                <div className="flex items-start gap-4">
                  {/* Left Indicator & Line */}
                  <div className="flex flex-col items-center shrink-0 w-8 self-stretch">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black border-2 shrink-0 z-10 transition-all ${
                      isProblemAccepted
                        ? 'bg-[#2c4230] border-[#2c4230] text-white shadow-md'
                        : 'bg-amber-100 border-amber-400 text-amber-900 animate-pulse'
                    }`}>
                      {isProblemAccepted ? <Check size={16} /> : '1'}
                    </div>
                    <div className={`w-0.5 flex-1 my-2 transition-colors ${
                      isProblemAccepted ? 'bg-[#2c4230]' : 'bg-[#e2ded0]'
                    }`} style={{ minHeight: '32px' }} />
                  </div>

                  {/* Step Card Content */}
                  <div className={`flex-1 p-5 rounded-2xl border transition-all ${
                    isProblemAccepted ? 'bg-[#f4f1e1]/60 border-[#4a6b4e]/40 shadow-sm' : 'bg-white border-[#e2ded0]'
                  }`}>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <GraduationCap className={isProblemAccepted ? 'text-[#4a6b4e]' : 'text-[#7d8c7c]'} size={18} />
                        <h4 className="text-sm font-extrabold text-[#2c4230]">Step 1: Problem Accepted by Academic Institution</h4>
                      </div>
                      <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full ${
                        isProblemAccepted ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' : 'bg-amber-100 text-amber-800'
                      }`}>
                        {isProblemAccepted ? 'ACCEPTED' : 'PENDING ACCEPTANCE'}
                      </span>
                    </div>

                    {isProblemAccepted ? (
                      <div className="space-y-2 mt-3">
                        <div className="p-3 bg-white rounded-xl border border-[#e2ded0] text-xs text-[#3e4a36] space-y-1">
                          <p className="font-bold text-[#2c4230] text-sm flex items-center gap-1.5">
                            <CheckCircle2 size={14} className="text-[#4a6b4e]" />
                            {assignedUniversityName || 'Assigned Engineering Institution'}
                          </p>
                          <p className="text-[#556958]">
                            The institution has officially adopted this municipal problem statement into its R&D lab pipeline.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-[#7d8c7c] mt-1">
                        Currently awaiting approval from allocated engineering universities in the district.
                      </p>
                    )}
                  </div>
                </div>

                {/* STEP 2: TEAM FORMED */}
                <div className="flex items-start gap-4">
                  {/* Left Indicator & Line */}
                  <div className="flex flex-col items-center shrink-0 w-8 self-stretch">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black border-2 shrink-0 z-10 transition-all ${
                      isTeamFormed
                        ? 'bg-[#2c4230] border-[#2c4230] text-white shadow-md'
                        : isProblemAccepted
                        ? 'bg-[#f9d877] border-[#2c4230] text-[#2c4230] shadow-[0_0_0_4px_rgba(249,216,119,0.35)]'
                        : 'bg-white border-[#e2ded0] text-[#7d8c7c]'
                    }`}>
                      {isTeamFormed ? <Check size={16} /> : '2'}
                    </div>
                    <div className={`w-0.5 flex-1 my-2 transition-colors ${
                      isTeamFormed ? 'bg-[#2c4230]' : 'bg-[#e2ded0]'
                    }`} style={{ minHeight: '32px' }} />
                  </div>

                  {/* Step Card Content */}
                  <div className={`flex-1 p-5 rounded-2xl border transition-all ${
                    isTeamFormed ? 'bg-[#f4f1e1]/60 border-[#4a6b4e]/40 shadow-sm' : 'bg-white border-[#e2ded0]'
                  }`}>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <Users className={isTeamFormed ? 'text-[#4a6b4e]' : 'text-[#7d8c7c]'} size={18} />
                        <h4 className="text-sm font-extrabold text-[#2c4230]">Step 2: Student Innovation Team Formed</h4>
                      </div>
                      <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full ${
                        isTeamFormed ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' : isProblemAccepted ? 'bg-[#f9d877] text-[#2c4230]' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {isTeamFormed ? 'TEAM REGISTERED' : isProblemAccepted ? 'SETUP IN PROGRESS' : 'AWAITING ACCEPTANCE'}
                      </span>
                    </div>

                    {team ? (
                      <div className="space-y-3 mt-3">
                        <div className="p-4 bg-white rounded-xl border border-[#e2ded0] text-xs space-y-2">
                          <div className="flex items-center justify-between border-b border-[#e2ded0] pb-2">
                            <span className="font-bold text-[#2c4230] text-sm">Team: {team.teamName}</span>
                            <span className="text-[11px] font-semibold text-[#4a6b4e]">
                              Mentor: {team.mentorName || 'Faculty Advisor'}
                            </span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                            <div>
                              <span className="text-[10.5px] font-bold uppercase tracking-wider text-[#7d8c7c] block mb-1">
                                Team Leader
                              </span>
                              <div className="flex items-center gap-2 font-semibold text-[#2c4230]">
                                <div className="w-6 h-6 rounded-full bg-[#2c4230] text-[#f4f1e1] text-[10px] font-bold flex items-center justify-center">
                                  {team.leaderName?.charAt(0).toUpperCase()}
                                </div>
                                <span>{team.leaderName} ({team.leaderGender || 'Student'})</span>
                              </div>
                            </div>

                            <div>
                              <span className="text-[10.5px] font-bold uppercase tracking-wider text-[#7d8c7c] block mb-1">
                                Team Members ({team.members?.length || 0})
                              </span>
                              <div className="flex flex-wrap gap-1.5">
                                {Array.isArray(team.members) && team.members.length > 0 ? (
                                  team.members.map((m: any, mIdx: number) => (
                                    <span key={mIdx} className="bg-[#f4f1e1] px-2 py-0.5 rounded-md border border-[#e2ded0] text-[11px] text-[#3e4a36] font-medium">
                                      {m.name} ({m.gender?.charAt(0)})
                                    </span>
                                  ))
                                ) : (
                                  <span className="text-[#7d8c7c]">Active student contributors</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-[#7d8c7c] mt-1">
                        {isProblemAccepted ? 'Faculty mentor is assigning student researchers and building the project team.' : 'Team registration will unlock once the problem statement is accepted.'}
                      </p>
                    )}
                  </div>
                </div>

                {/* STEP 3: SOLUTION LOCKED & COMPLETED */}
                <div className="flex items-start gap-4">
                  {/* Left Indicator & Line */}
                  <div className="flex flex-col items-center shrink-0 w-8 self-stretch">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black border-2 shrink-0 z-10 transition-all ${
                      hasSolution
                        ? 'bg-[#2c4230] border-[#2c4230] text-white shadow-md'
                        : isTeamFormed
                        ? 'bg-[#f9d877] border-[#2c4230] text-[#2c4230] shadow-[0_0_0_4px_rgba(249,216,119,0.35)]'
                        : 'bg-white border-[#e2ded0] text-[#7d8c7c]'
                    }`}>
                      {hasSolution ? <Check size={16} /> : '3'}
                    </div>
                    <div className={`w-0.5 flex-1 my-2 transition-colors ${
                      hasSolution ? 'bg-[#2c4230]' : 'bg-[#e2ded0]'
                    }`} style={{ minHeight: '32px' }} />
                  </div>

                  {/* Step Card Content */}
                  <div className={`flex-1 p-5 rounded-2xl border transition-all ${
                    hasSolution ? 'bg-emerald-50/70 border-emerald-300 shadow-sm' : 'bg-white border-[#e2ded0]'
                  }`}>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        {hasSolution ? (
                          <CheckCircle2 className="text-emerald-700" size={18} />
                        ) : (
                          <Lock className="text-[#7d8c7c]" size={18} />
                        )}
                        <h4 className="text-sm font-extrabold text-[#2c4230]">Step 3: Engineering Solution Locked & Completed</h4>
                      </div>
                      <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full flex items-center gap-1 ${
                        hasSolution 
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' 
                          : isTeamFormed 
                          ? 'bg-amber-100 text-amber-800' 
                          : 'bg-gray-100 text-gray-600'
                      }`}>
                        {hasSolution ? (
                          <>
                            <Check size={12} className="text-emerald-700" /> DONE / SOLUTION LOCKED
                          </>
                        ) : isTeamFormed ? 'ACTIVE PROTOTYPING' : 'PENDING'}
                      </span>
                    </div>

                    {hasSolution ? (
                      <div className="space-y-3 mt-3">
                        <div className="p-4 bg-white rounded-xl border border-emerald-200 text-xs space-y-3 shadow-xs">
                          <div>
                            <span className="text-[10.5px] font-bold uppercase tracking-wider text-emerald-800 font-mono block mb-1">
                              Solution Executive Summary
                            </span>
                            <p className="text-xs text-[#2c4230] leading-relaxed whitespace-pre-wrap">
                              {solution.description}
                            </p>
                          </div>

                          <div className="pt-2 border-t border-emerald-100 flex flex-wrap gap-2">
                            {solution.docxLink && (
                              <a
                                href={solution.docxLink}
                                target="_blank"
                                rel="noreferrer"
                                className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 text-emerald-900 font-bold rounded-lg text-xs flex items-center gap-1.5 transition-colors shadow-xs"
                              >
                                <FileText size={14} className="text-emerald-700" /> Technical Documentation
                              </a>
                            )}
                            {solution.demoVideoLink && (
                              <a
                                href={solution.demoVideoLink}
                                target="_blank"
                                rel="noreferrer"
                                className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 text-emerald-900 font-bold rounded-lg text-xs flex items-center gap-1.5 transition-colors shadow-xs"
                              >
                                <Video size={14} className="text-emerald-700" /> Demo Video
                              </a>
                            )}
                            {solution.prototypeLink && (
                              <a
                                href={solution.prototypeLink}
                                target="_blank"
                                rel="noreferrer"
                                className="px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 text-emerald-900 font-bold rounded-lg text-xs flex items-center gap-1.5 transition-colors shadow-xs"
                              >
                                <ExternalLink size={14} className="text-emerald-700" /> Prototype / Repository
                              </a>
                            )}
                          </div>

                          {solution.submittedAt && (
                            <p className="text-[10.5px] text-[#7d8c7c] pt-1">
                              Locked & Timestamped on {new Date(solution.submittedAt).toLocaleString()}
                            </p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-[#7d8c7c] mt-1">
                        {isTeamFormed ? 'The student innovation team is actively developing and testing the prototype.' : 'Solution submission unlocks once team is formed.'}
                      </p>
                    )}
                  </div>
                </div>

                {/* STEP 4: INDUSTRY PARTNERS ALLOCATED */}
                <div className="flex items-start gap-4">
                  {/* Left Indicator & Line */}
                  <div className="flex flex-col items-center shrink-0 w-8 self-stretch">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black border-2 shrink-0 z-10 transition-all ${
                      companySuggestions.length > 0 && hasSolution
                        ? 'bg-[#2c4230] border-[#2c4230] text-white shadow-md'
                        : companySuggestions.length > 0
                        ? 'bg-[#2c4230] border-[#2c4230] text-white shadow-md'
                        : 'bg-white border-[#e2ded0] text-[#7d8c7c]'
                    }`}>
                      {companySuggestions.length > 0 ? <Check size={16} /> : '4'}
                    </div>
                  </div>

                  {/* Step Card Content */}
                  <div className={`flex-1 p-5 rounded-2xl border transition-all ${
                    companySuggestions.length > 0 ? 'bg-[#2c4230]/5 border-[#4a6b4e]/40 shadow-sm' : 'bg-white border-[#e2ded0]'
                  }`}>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <Briefcase className={companySuggestions.length > 0 ? 'text-[#4a6b4e]' : 'text-[#7d8c7c]'} size={18} />
                        <h4 className="text-sm font-extrabold text-[#2c4230]">Step 4: Allocated Industry & Commercialization Partners</h4>
                      </div>
                      <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full ${
                        companySuggestions.length > 0 ? 'bg-[#2c4230] text-[#f9d877]' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {companySuggestions.length > 0 ? `${companySuggestions.length} ALLOCATED PARTNERS` : 'PENDING'}
                      </span>
                    </div>

                    <p className="text-xs text-[#556958] mb-3">
                      Industrial partners matched by domain expertise, GIS proximity, and CSR/scaling capability to adopt and fund the validated solution.
                    </p>

                    {companySuggestions.length > 0 ? (
                      <div className="space-y-3">
                        {companySuggestions.map((company: any, cIdx: number) => {
                          const score = company.match_score !== undefined && company.match_score !== null
                            ? (company.match_score <= 1 ? (company.match_score * 100).toFixed(1) : Number(company.match_score).toFixed(1))
                            : null;

                          return (
                            <div key={cIdx} className="p-4 bg-white rounded-xl border border-[#e2ded0] hover:border-[#4a6b4e]/50 transition-colors shadow-xs">
                              <div className="flex items-start justify-between gap-2 mb-1.5">
                                <div className="flex items-center gap-2">
                                  <span className="w-5 h-5 rounded-full bg-[#2c4230] text-[#f4f1e1] text-[10px] font-bold flex items-center justify-center shrink-0">
                                    #{cIdx + 1}
                                  </span>
                                  <h5 className="font-bold text-sm text-[#2c4230]">
                                    {company.company_name || company.name || 'Industry Partner'}
                                  </h5>
                                </div>
                                {score && (
                                  <span className="px-2.5 py-0.5 bg-[#2c4230] text-[#f9d877] text-xs font-black rounded-full shadow-xs shrink-0">
                                    {score}% Match
                                  </span>
                                )}
                              </div>

                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#556958] mb-1.5">
                                {company.district && (
                                  <span className="flex items-center gap-1">
                                    <MapPin size={12} className="text-[#4a6b4e]" /> {company.district}, {company.state || 'Delhi'}
                                  </span>
                                )}
                                {company.distance_km !== undefined && company.distance_km !== null && (
                                  <span>• {Number(company.distance_km).toFixed(1)} km from problem site</span>
                                )}
                                {company.domain && (
                                  <span className="capitalize bg-[#f4f1e1] px-2 py-0.5 rounded-md border border-[#e2ded0] text-[10.5px] font-semibold text-[#2c4230]">
                                    {company.domain}
                                  </span>
                                )}
                              </div>

                              {(company.expertise || company.core_capabilities) && (
                                <p className="text-xs text-[#4a5848] leading-relaxed pt-1 border-t border-[#f4f1e1]">
                                  <span className="font-semibold text-[#2c4230]">Capabilities / CSR Focus:</span> {company.expertise || company.core_capabilities}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="p-4 bg-white rounded-xl border border-[#e2ded0] text-center text-xs text-[#7d8c7c]">
                        Industry matching pipeline runs automatically upon solution submission or university adoption.
                      </div>
                    )}
                  </div>
                </div>

              </div>
            </section>

            {/* AI Analysis Brief */}
            {problem.aiAnalysis && (
              <section className="bg-gradient-to-br from-[#2c4230] to-[#1e2d21] text-[#f4f1e1] p-8 rounded-3xl shadow-md relative overflow-hidden">
                <div className="absolute inset-0 opacity-15 bg-[url('https://www.transparenttextures.com/patterns/wood-pattern.png')] mix-blend-overlay"></div>
                <div className="relative z-10 space-y-4">
                  <h3 className="text-xl font-bold flex items-center gap-2 text-[#f9d877]">
                    <Sparkles size={20} /> IndicBERT AI Intelligence Brief
                  </h3>
                  
                  <div className="bg-white/10 backdrop-blur-md p-4 rounded-2xl border border-white/15">
                    <p className="text-xs font-bold text-[#a4c2a8] uppercase tracking-wider mb-1 font-mono">AI Executive Summary</p>
                    <p className="text-sm leading-relaxed">{problem.aiAnalysis.summary}</p>
                  </div>

                  {problem.aiAnalysis.suggested_solution && (
                    <div className="bg-white/10 backdrop-blur-md p-4 rounded-2xl border border-white/15">
                      <p className="text-xs font-bold text-[#f9d877] uppercase tracking-wider mb-1 font-mono">Suggested Engineering Direction</p>
                      <p className="text-xs leading-relaxed text-[#f4f1e1]/90">{problem.aiAnalysis.suggested_solution}</p>
                    </div>
                  )}

                  {problem.aiAnalysis.required_expertise && (
                    <div className="pt-2">
                      <p className="text-xs font-bold text-[#a4c2a8] uppercase tracking-wider mb-2 font-mono">Required Domain Expertise</p>
                      <div className="flex flex-wrap gap-2">
                        {problem.aiAnalysis.required_expertise.map((exp: string, idx: number) => (
                          <span key={idx} className="bg-white/15 text-white px-3 py-1 rounded-full text-xs font-semibold border border-white/20">
                            {exp}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Real Backend Community Discussion Section */}
            <section className="bg-white p-8 rounded-3xl border border-[#e2ded0] shadow-[0_4px_20px_rgba(0,0,0,0.04)] space-y-6">
              <h3 className="text-lg font-bold text-[#2c4230] flex items-center gap-2">
                <MessageSquare className="text-[#4a6b4e]" size={20} /> Community Discussion & Updates ({comments.length})
              </h3>

              {/* Add Comment Input */}
              <form onSubmit={handleAddComment} className="flex gap-3">
                <input
                  type="text"
                  placeholder="Share a field observation, question, or solution update..."
                  className="flex-1 px-4 py-3 bg-[#f4f1e1]/80 border border-[#e2ded0] rounded-2xl text-xs outline-none focus:bg-white focus:border-[#4a6b4e] text-[#2c4230]"
                  value={newComment}
                  onChange={e => setNewComment(e.target.value)}
                  disabled={submittingComment}
                />
                <button
                  type="submit"
                  disabled={submittingComment || !newComment.trim()}
                  className="px-5 py-3 bg-[#2c4230] hover:bg-[#1e2d21] text-[#f4f1e1] font-bold text-xs rounded-2xl flex items-center gap-1.5 transition-all shadow-sm disabled:opacity-60"
                >
                  <Send size={14} /> {submittingComment ? 'Posting...' : 'Post'}
                </button>
              </form>

              {/* Comment List */}
              <div className="space-y-3 pt-2">
                {commentsLoading ? (
                  <div className="text-center py-6 text-xs text-[#7d8c7c]">Loading comments...</div>
                ) : comments.length === 0 ? (
                  <div className="p-6 bg-[#f4f1e1]/40 rounded-2xl border border-[#e2ded0] text-center text-xs text-[#7d8c7c]">
                    No community updates or comments yet. Post the first update above!
                  </div>
                ) : (
                  comments.map((c: any) => {
                    const authorName = c.author?.name || c.authorName || 'Citizen Contributor';
                    const authorRole = c.author?.role ? c.author.role.replace('_', ' ') : 'Citizen';
                    const commentDate = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : 'Recent';

                    return (
                      <div key={c._id || c.id} className="p-4 bg-[#f4f1e1]/50 rounded-2xl border border-[#e2ded0] flex items-start gap-3">
                        <div className="w-9 h-9 rounded-full bg-[#2c4230] text-[#f4f1e1] font-bold text-xs flex items-center justify-center shrink-0 border border-[#4a6b4e]/30">
                          {authorName.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-[#2c4230]">{authorName}</span>
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-[#2c4230]/10 text-[#2c4230] capitalize">
                                {authorRole}
                              </span>
                            </div>
                            <span className="text-[10px] text-[#7d8c7c]">{commentDate}</span>
                          </div>
                          <p className="text-xs text-[#3e4a36] leading-relaxed">{c.text || c.content}</p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>

          {/* Right Sidebar: Allocated Universities, GIS Map, Evidence */}
          <div className="space-y-8">
            
            {/* Allocated / Suggested Academic Institutions */}
            <section className="bg-white p-6 rounded-3xl border border-[#e2ded0] shadow-[0_4px_20px_rgba(0,0,0,0.04)] space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold text-[#2c4230] uppercase tracking-wider flex items-center gap-2 font-mono">
                  <Building2 className="text-[#4a6b4e]" size={16} /> Allocated Universities
                </h3>
                <div className="flex items-center gap-2">
                  {collegeSuggestions.length > 0 && (
                    <span className="text-[10px] font-bold text-[#4a6b4e] bg-[#4a6b4e]/10 px-2.5 py-0.5 rounded-full">
                      {collegeSuggestions.length} Matches
                    </span>
                  )}
                  <button
                    onClick={handleTriggerCollegeMatching}
                    disabled={matchingColleges}
                    className="text-[11px] font-bold text-[#4a6b4e] hover:text-[#2c4230] flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[#e2ded0] hover:bg-[#f4f1e1] transition-all disabled:opacity-50 cursor-pointer"
                    title="Match Colleges using Hugging Face TeamSetu Model"
                  >
                    <RefreshCw size={12} className={matchingColleges ? 'animate-spin' : ''} />
                    {matchingColleges ? 'Matching...' : 'Match Colleges'}
                  </button>
                </div>
              </div>

              {collegeMatchError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 flex items-start gap-2">
                  <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold">{collegeMatchError}</p>
                    <p className="text-[11px] text-red-600 mt-0.5">
                      Ensure your Hugging Face access token is configured in backend environment variables for ZeroGPU quota.
                    </p>
                  </div>
                </div>
              )}
              
              {collegeSuggestions.length > 0 ? (
                <div className="space-y-3">
                  {collegeSuggestions.map((college: any, idx: number) => {
                    const isAccepted = 
                      assignedUniversityName && 
                      (assignedUniversityName.toLowerCase().includes((college.college_name || '').toLowerCase()) || 
                       (college.college_name || '').toLowerCase().includes(assignedUniversityName.toLowerCase()));
                    const score = college.match_score !== undefined && college.match_score !== null
                      ? (college.match_score <= 1 ? (college.match_score * 100).toFixed(1) : Number(college.match_score).toFixed(1))
                      : null;

                    return (
                      <div 
                        key={idx} 
                        className={`p-3.5 rounded-2xl border transition-all ${
                          isAccepted 
                            ? 'bg-[#f4f1e1] border-[#4a6b4e] shadow-sm' 
                            : 'bg-[#f4f1e1]/50 hover:bg-[#f4f1e1] border-[#e2ded0]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                          <div className="flex items-center gap-1.5">
                            <span className="w-5 h-5 rounded-full bg-[#2c4230] text-[#f4f1e1] text-[10px] font-bold flex items-center justify-center shrink-0">
                              #{idx + 1}
                            </span>
                            <span className="text-[11px] font-bold text-[#4a6b4e] uppercase tracking-wider">
                              {isAccepted ? 'Adopted Institution' : 'Allocated College'}
                            </span>
                          </div>
                          {score && (
                            <span className="text-xs font-extrabold px-2.5 py-0.5 rounded-full bg-[#2c4230] text-[#f9d877] shadow-sm shrink-0">
                              {score}% Match
                            </span>
                          )}
                        </div>

                        <h4 className="font-bold text-sm text-[#2c4230] leading-snug">
                          {college.college_name || 'Institution Name'}
                        </h4>

                        <div className="text-xs text-[#556958] mt-1.5 space-y-1">
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                            {college.district && (
                              <span className="flex items-center gap-1">
                                <MapPin size={12} className="text-[#4a6b4e]" /> {college.district}
                              </span>
                            )}
                            {college.distance_km !== undefined && college.distance_km !== null && (
                              <span>• {Number(college.distance_km).toFixed(1)} km away</span>
                            )}
                            {college.domain && (
                              <span className="capitalize bg-white/80 px-2 py-0.5 rounded-md border border-[#e2ded0] text-[10px] font-semibold text-[#2c4230]">
                                {college.domain}
                              </span>
                            )}
                          </div>

                          {college.faculty_expertise && (
                            <p className="text-[11px] text-[#4a5848] line-clamp-2 pt-0.5">
                              <span className="font-semibold text-[#2c4230]">Faculty:</span> {college.faculty_expertise}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : assignedUniversityName ? (
                <div className="p-4 bg-[#f4f1e1] rounded-2xl border border-[#e2ded0]">
                  <div className="flex items-center gap-2 text-[#4a6b4e] mb-1">
                    <GraduationCap size={16} />
                    <span className="text-[11px] font-bold uppercase tracking-wider">Adopted Institution</span>
                  </div>
                  <h4 className="font-bold text-sm text-[#2c4230]">{assignedUniversityName}</h4>
                </div>
              ) : (
                <div className="p-5 bg-[#f4f1e1]/60 rounded-2xl border border-[#e2ded0] text-center space-y-3">
                  <GraduationCap size={28} className="mx-auto text-[#7d8c7c]" />
                  <h4 className="text-xs font-bold text-[#2c4230]">Awaiting University Allocation</h4>
                  <p className="text-[11px] text-[#556958]">
                    AI matching engine evaluates nearby engineering colleges based on domain specialization and proximity.
                  </p>
                  <button
                    onClick={handleTriggerCollegeMatching}
                    disabled={matchingColleges}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-xl bg-[#2c4230] text-[#f4f1e1] hover:bg-[#3d5a42] transition-colors disabled:opacity-50 cursor-pointer shadow-sm"
                  >
                    <Sparkles size={14} className={matchingColleges ? 'animate-spin' : ''} />
                    {matchingColleges ? 'Matching via TeamSetu...' : 'Run College Matcher'}
                  </button>
                </div>
              )}
            </section>

            {/* Geolocation Map Widget */}
            <section className="bg-white p-6 rounded-3xl border border-[#e2ded0] shadow-[0_4px_20px_rgba(0,0,0,0.04)] space-y-3">
              <h3 className="text-xs font-bold text-[#2c4230] uppercase tracking-wider flex items-center gap-2 font-mono">
                <MapPin className="text-[#4a6b4e]" size={16} /> GIS Location
              </h3>
              
              <div className="h-56 rounded-2xl overflow-hidden border border-[#e2ded0] relative z-0">
                <MapContainer center={[lat, lng]} zoom={12} style={{ height: '100%', width: '100%' }}>
                  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                  <Marker position={[lat, lng]}>
                    <Popup>
                      <strong>{problem.title}</strong><br/>
                      {problem.location?.district}, {problem.location?.state}
                    </Popup>
                  </Marker>
                </MapContainer>
              </div>

              <div className="text-xs text-[#556958] space-y-1 pt-1">
                <p><strong>District:</strong> {problem.location?.district || 'Ranchi'}</p>
                <p><strong>Coordinates:</strong> {Number(lat).toFixed(4)}° N, {Number(lng).toFixed(4)}° E</p>
              </div>
            </section>

            {/* Photo Evidence Gallery */}
            <section className="bg-white p-6 rounded-3xl border border-[#e2ded0] shadow-[0_4px_20px_rgba(0,0,0,0.04)] space-y-3">
              <h3 className="text-xs font-bold text-[#2c4230] uppercase tracking-wider flex items-center gap-2 font-mono">
                <FileText className="text-[#4a6b4e]" size={16} /> Photo & Evidence
              </h3>

              {validMedia.length > 0 ? (
                <div className="grid grid-cols-2 gap-2">
                  {validMedia.map((media: any, idx: number) => (
                    <a 
                      key={idx} 
                      href={media.url} 
                      target="_blank" 
                      rel="noreferrer" 
                      className="block rounded-xl overflow-hidden border border-[#e2ded0] hover:scale-105 transition-transform"
                    >
                      <img 
                        src={media.url} 
                        alt={media.name || "Evidence"} 
                        className="w-full h-24 object-cover" 
                      />
                    </a>
                  ))}
                </div>
              ) : (
                <div className="p-6 bg-[#f4f1e1]/60 rounded-2xl border border-[#e2ded0] text-center flex flex-col items-center justify-center gap-1.5">
                  <ImageOff size={22} className="text-[#a4b3a4]" />
                  <span className="text-xs font-semibold text-[#7d8c7c]">No Evidence Attached</span>
                </div>
              )}
            </section>

          </div>

        </div>
      </main>
    </div>
  );
};

export default ProblemDetail;
