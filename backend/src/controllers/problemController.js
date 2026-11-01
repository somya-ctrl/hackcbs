const ProblemStatement = require('../models/ProblemStatement');
const Comment = require('../models/Comment');
const Company = require('../models/Company');
const Notification = require('../models/Notification');
const { User } = require('../models/User');
const pushNotificationService = require('../services/pushNotificationService');
const { validateProblemSubmission } = require('../validations/problemValidation');
const { analyzeProblemWithGroq } = require('../services/aiService');
const {
  runAIPipeline,
  runProblemAnalysis,
  runDeduplication,
  runCompanyMatchingPipeline,
  runCollegeMatchingPipeline
} = require('../services/pythonAiService');
const { translateToEnglish } = require('../services/translationService');

// Haversine formula to calculate distance in km between two GPS coordinates
const haversineDistanceKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

// District coordinates dictionary for fallback lookup if user denied browser geolocation
const DISTRICT_COORDINATES = {
  'mathura': { latitude: 27.4924, longitude: 77.6737 },
  'delhi': { latitude: 28.6139, longitude: 77.2090 },
  'new delhi': { latitude: 28.6139, longitude: 77.2090 },
  'jaipur': { latitude: 26.9124, longitude: 75.7873 },
  'mumbai': { latitude: 19.0760, longitude: 72.8777 },
  'bangalore': { latitude: 12.9716, longitude: 77.5946 },
  'bengaluru': { latitude: 12.9716, longitude: 77.5946 },
  'hyderabad': { latitude: 17.3850, longitude: 78.4867 },
  'chennai': { latitude: 13.0827, longitude: 80.2707 },
  'kolkata': { latitude: 22.5726, longitude: 88.3639 },
  'lucknow': { latitude: 26.8467, longitude: 80.9462 },
  'pune': { latitude: 18.5204, longitude: 73.8567 },
  'ahmedabad': { latitude: 23.0225, longitude: 72.5714 }
};

// Helper: Normalize GPS coordinates from frontend allow-location prompt
const resolveCoordinates = (loc = {}) => {
  let lat = null;
  let lng = null;

  if (loc.coordinates && loc.coordinates.latitude != null && loc.coordinates.longitude != null) {
    lat = Number(loc.coordinates.latitude);
    lng = Number(loc.coordinates.longitude);
  } else if (loc.latitude != null && loc.longitude != null) {
    lat = Number(loc.latitude);
    lng = Number(loc.longitude);
  }

  // Fallback: District name → approximate coordinates
  if ((lat === null || lng === null) && loc.district) {
    const distKey = loc.district.toLowerCase().trim();
    if (DISTRICT_COORDINATES[distKey]) {
      lat = DISTRICT_COORDINATES[distKey].latitude;
      lng = DISTRICT_COORDINATES[distKey].longitude;
    } else {
      lat = 20.5937;  // India centre
      lng = 78.9629;
    }
  }

  return { latitude: lat, longitude: lng };
};

// @desc    Submit Problem Statement → Groq AI Classify → Embed → FAISS Dedup → DB Save → Return to Frontend
// @route   POST /api/problems
// @access  Private (JWT Required)
const createProblemStatement = async (req, res, next) => {
  try {
    // 1. Validate request payload
    const { error } = validateProblemSubmission(req.body);
    if (error) {
      const messages = error.details.map((d) => d.message);
      return res.status(400).json({ success: false, message: messages.join(', ') });
    }

    const {
      title,
      description,
      location,
      imagesAndMedia,
      desiredOutcome,
      supportingInfo = {},
      selfTags = {},
      language = 'English'
    } = req.body;

    // Translation Logic (Inbound)
    let englishTitle = title;
    let englishDescription = description;
    
    if (language && language !== 'English') {
      const { translateToEnglish, translateFromEnglish } = require('../services/translationService');
      englishTitle = await translateToEnglish(title, language);
      englishDescription = await translateToEnglish(description, language);
    }

    // 2. Normalize GPS coordinates
    location.coordinates = resolveCoordinates(location);

    // 3. Fetch existing problems in the same district for deduplication candidates
    const candidates = await ProblemStatement.find({
      'location.district': new RegExp(`^${location.district}$`, 'i'),
      isDuplicate: false
    })
      .select('_id title description location embedding aiAnalysis masterTicketId')
      .lean();

    console.log(`[AI Pipeline]: Found ${candidates.length} candidate(s) in district "${location.district}" for dedup check.`);

    // 4. Run unified Python AI Pipeline (Groq Classify → Embed → FAISS Dedup → College & Company Match)
    let aiAnalysis, embedding, deduplication, collegeSuggestions, companySuggestions;
    let pythonPipelineUsed = true;

    try {
      const pipelineResult = await runAIPipeline(englishDescription, location, selfTags, candidates);
      aiAnalysis = pipelineResult.aiAnalysis;
      embedding = pipelineResult.embedding;
      deduplication = pipelineResult.deduplication;
      collegeSuggestions = Array.isArray(pipelineResult.matchedColleges) ? pipelineResult.matchedColleges : [];
      companySuggestions = Array.isArray(pipelineResult.matchedCompanies) ? pipelineResult.matchedCompanies : [];
      console.log(`[AI Pipeline]: Success. isDuplicate=${deduplication?.is_duplicate}, category=${aiAnalysis?.problem_classification}, colleges=${collegeSuggestions.length}, companies=${companySuggestions.length}`);
    } catch (pythonErr) {
      console.warn('[AI Pipeline Modular Invocation]: Composite pipeline notice:', pythonErr.message);
      pythonPipelineUsed = false;

      // 1. Invoke API 1: Problem Analyzer (Hugging Face)
      try {
        aiAnalysis = await runProblemAnalysis(englishDescription);
      } catch (analErr) {
        console.warn('[AI Problem Analyzer Notice]: Direct Groq fallback:', analErr.message);
        aiAnalysis = await analyzeProblemWithGroq(englishDescription);
      }

      // 2. Invoke API 2: Deduplication Checker (Hugging Face) if candidates exist
      embedding = [];
      deduplication = { is_duplicate: false, matched_problem_id: null, similarity_score: 0, distance_km: null, matched_problem: null };
      if (candidates.length > 0 && aiAnalysis) {
        try {
          const dedupRes = await runDeduplication(aiAnalysis, location, candidates);
          if (dedupRes?.deduplication) {
            deduplication = dedupRes.deduplication;
            embedding = dedupRes.embedding || [];
          }
        } catch (dErr) {
          console.warn('[AI Deduplication Notice]:', dErr.message);
        }
      }

      // 3. Invoke API 3: College Matcher (Hugging Face)
      try {
        collegeSuggestions = await runCollegeMatchingPipeline(aiAnalysis || { description: englishDescription }, location, 5);
      } catch (cErr) {
        console.error('[Hugging Face College Matcher]:', cErr.message);
        collegeSuggestions = [];
      }
      companySuggestions = [];
    }

    // 5. Auto-update urgency from AI severity
    if (aiAnalysis?.severity && !supportingInfo.urgency) {
      const severityToUrgency = { low: 'LOW', medium: 'MEDIUM', high: 'HIGH', critical: 'CRITICAL' };
      supportingInfo.urgency = severityToUrgency[aiAnalysis.severity] || 'MEDIUM';
    }

    // 6. Determine duplicate/unique status and build DB document
    const isDuplicate = deduplication?.is_duplicate === true;
    const matchedId = deduplication?.matched_problem_id || null;
    const masterTicketId = isDuplicate ? (deduplication?.master_ticket_id || matchedId) : null;

    // Translation Logic (Outbound for AI Analysis)
    if (language && language !== 'English' && aiAnalysis) {
      const { translateFromEnglish } = require('../services/translationService');
      if (aiAnalysis.summary) {
        aiAnalysis.summary_original = await translateFromEnglish(aiAnalysis.summary, language);
      }
      if (aiAnalysis.suggested_solution) {
        aiAnalysis.suggested_solution_original = await translateFromEnglish(aiAnalysis.suggested_solution, language);
      }
    }

    const problemDoc = await ProblemStatement.create({
      language,
      title,
      description,
      englishTitle,
      englishDescription,
      location,
      imagesAndMedia: imagesAndMedia || [],
      desiredOutcome,
      supportingInfo,
      selfTags,
      aiAnalysis: { ...aiAnalysis, analyzedAt: new Date() },
      embedding,
      isDuplicate,
      duplicateOf: isDuplicate && matchedId
        ? { problemId: matchedId, similarityScore: deduplication.similarity_score, distanceKm: deduplication.distance_km }
        : undefined,
      masterTicketId: masterTicketId || undefined,
      collegeSuggestions,
      companySuggestions,
      submittedBy: req.user._id,
      status: isDuplicate ? 'DUPLICATE' : 'CLASSIFIED'
    });

    await problemDoc.populate('submittedBy', 'name email role profileDetails');

    // Trigger Notifications (Submitter confirmation & Nearby citizens under 10 km)
    (async () => {
      try {
        // A. Submitter confirmation notification
        const submitTitle = isDuplicate ? 'Duplicate Problem Linked' : 'Problem Statement Registered';
        const submitMessage = isDuplicate
          ? `Your report "${problemDoc.title}" has been registered and linked to an existing master ticket in your area.`
          : `Your report "${problemDoc.title}" has been successfully submitted and analyzed by AI.`;

        await Notification.create({
          recipient: req.user._id,
          type: 'PROBLEM_POSTED',
          title: submitTitle,
          message: submitMessage,
          problemId: problemDoc._id,
          metadata: {
            status: problemDoc.status,
            category: problemDoc.aiAnalysis?.problem_classification || 'Civic Issue',
            isDuplicate: isDuplicate
          }
        });

        // Dispatch FCM push to submitter
        pushNotificationService.sendPushToUser(req.user._id, {
          title: submitTitle,
          body: submitMessage,
          data: {
            problemId: problemDoc._id.toString(),
            type: 'PROBLEM_POSTED'
          }
        }).catch((e) => console.error('[Push Dispatch Submitter Error]:', e.message));

        // B. Nearby citizens alert within 10 km radius
        const coords = problemDoc.location?.coordinates;
        if (coords?.latitude && coords?.longitude) {
          const pLat = Number(coords.latitude);
          const pLng = Number(coords.longitude);

          const candidateUsers = await User.find({
            _id: { $ne: req.user._id },
            $or: [
              { 'lastKnownLocation.coordinates.latitude': { $exists: true, $ne: null } },
              { 'profileDetails.district': new RegExp(`^${problemDoc.location.district}$`, 'i') }
            ]
          }).select('_id lastKnownLocation profileDetails').lean();

          const nearbyAlerts = [];
          for (const u of candidateUsers) {
            let distKm = null;
            if (u.lastKnownLocation?.coordinates?.latitude && u.lastKnownLocation?.coordinates?.longitude) {
              distKm = haversineDistanceKm(
                pLat, pLng,
                u.lastKnownLocation.coordinates.latitude,
                u.lastKnownLocation.coordinates.longitude
              );
              if (distKm <= 10.0) {
                nearbyAlerts.push({
                  recipient: u._id,
                  type: 'NEARBY_PROBLEM',
                  title: 'New Issue Near You (<10 km)',
                  message: `A new civic issue "${problemDoc.title}" was reported ${distKm.toFixed(1)} km from your location.`,
                  problemId: problemDoc._id,
                  distanceKm: parseFloat(distKm.toFixed(2)),
                  metadata: {
                    category: problemDoc.aiAnalysis?.problem_classification || 'Civic Issue',
                    district: problemDoc.location.district
                  }
                });
              }
            } else if (u.profileDetails?.district && u.profileDetails.district.toLowerCase() === problemDoc.location.district?.toLowerCase()) {
              // Fallback to district matching if GPS not recorded yet
              nearbyAlerts.push({
                recipient: u._id,
                type: 'NEARBY_PROBLEM',
                title: 'New Issue in Your District',
                message: `A new civic issue "${problemDoc.title}" was reported in ${problemDoc.location.district}.`,
                problemId: problemDoc._id,
                distanceKm: null,
                metadata: {
                  category: problemDoc.aiAnalysis?.problem_classification || 'Civic Issue',
                  district: problemDoc.location.district
                }
              });
            }
          }

          if (nearbyAlerts.length > 0) {
            await Notification.insertMany(nearbyAlerts);

            // Dispatch FCM multicast push to nearby recipients
            const recipientIds = nearbyAlerts.map((a) => a.recipient);
            pushNotificationService.sendPushToUsers(recipientIds, {
              title: 'Civic Alert Near You',
              body: `A new issue "${problemDoc.title}" was reported in your vicinity.`,
              data: {
                problemId: problemDoc._id.toString(),
                type: 'NEARBY_PROBLEM'
              }
            }).catch((e) => console.error('[Push Dispatch Nearby Error]:', e.message));
          }
        }
      } catch (notifErr) {
        console.error('[Notification Dispatch Error]:', notifErr.message);
      }
    })();

    // 8. Build appropriate frontend response based on duplicate result
    if (isDuplicate) {
      const simPct = ((deduplication.similarity_score || 0) * 100).toFixed(1);
      const distKm = deduplication.distance_km != null ? `${deduplication.distance_km} km` : 'same area';

      return res.status(201).json({
        success: true,
        isDuplicate: true,
        message: `Problem submitted! A similar problem already exists in your area (${distKm} away, ${simPct}% similarity). Your submission has been linked to the existing master ticket.`,
        data: {
          _id: problemDoc._id,
          title: problemDoc.title,
          description: problemDoc.description,
          location: problemDoc.location,
          imagesAndMedia: problemDoc.imagesAndMedia,
          desiredOutcome: problemDoc.desiredOutcome,
          supportingInfo: problemDoc.supportingInfo,
          selfTags: problemDoc.selfTags,
          aiAnalysis: problemDoc.aiAnalysis,
          status: problemDoc.status,
          isDuplicate: true,
          duplicateOf: problemDoc.duplicateOf,
          masterTicketId: problemDoc.masterTicketId,
          deduplicationDetails: {
            similarity_score: deduplication.similarity_score,
            distance_km: deduplication.distance_km,
            matched_title: deduplication.matched_problem?.matched_title || null
          },
          collegeSuggestions: problemDoc.collegeSuggestions || [],
          submittedBy: problemDoc.submittedBy,
          createdAt: problemDoc.createdAt
        }
      });
    }

    // Unique problem response
    return res.status(201).json({
      success: true,
      isDuplicate: false,
      message: 'Problem statement submitted and classified by Groq AI successfully!',
      data: {
        _id: problemDoc._id,
        title: problemDoc.title,
        description: problemDoc.description,
        location: problemDoc.location,
        imagesAndMedia: problemDoc.imagesAndMedia,
        desiredOutcome: problemDoc.desiredOutcome,
        supportingInfo: problemDoc.supportingInfo,
        selfTags: problemDoc.selfTags,
        aiAnalysis: problemDoc.aiAnalysis,
        status: problemDoc.status,
        isDuplicate: false,
        masterTicketId: problemDoc._id,
        collegeSuggestions: problemDoc.collegeSuggestions || [],
        submittedBy: problemDoc.submittedBy,
        createdAt: problemDoc.createdAt
      }
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get All Problem Statements (filters: ?my=true, ?category=, ?district=, ?state=, ?status=, ?duplicate=, ?page=, ?limit=)
// @route   GET /api/problems
// @access  Private
const getAllProblemStatements = async (req, res, next) => {
  try {
    const filter = {};

    if (req.query.my === 'true' && req.user) filter.submittedBy = req.user._id;
    if (req.query.saved === 'true' && req.user) filter.savedBy = req.user._id;
    if (req.query.following === 'true' && req.user) filter.followers = req.user._id;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.category) filter['aiAnalysis.problem_classification'] = new RegExp(req.query.category, 'i');
    if (req.query.district) filter['location.district'] = new RegExp(`^${req.query.district}$`, 'i');
    if (req.query.state) filter['location.state'] = new RegExp(req.query.state, 'i');
    if (req.query.duplicate === 'false') filter.isDuplicate = false;
    if (req.query.duplicate === 'true') filter.isDuplicate = true;

    // Pagination setup
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const startIndex = (page - 1) * limit;

    const total = await ProblemStatement.countDocuments(filter);

    const problems = await ProblemStatement.find(filter)
      .populate('submittedBy', 'name email role')
      .sort({ createdAt: -1 })
      .skip(startIndex)
      .limit(limit);

    // Pagination result
    const pagination = {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit)
    };

    return res.status(200).json({ success: true, count: problems.length, pagination, data: problems });
  } catch (err) {
    next(err);
  }
};

// @desc    Get Single Problem Statement by ID
// @route   GET /api/problems/:id
// @access  Private
const getProblemStatementById = async (req, res, next) => {
  try {
    const problem = await ProblemStatement.findById(req.params.id);
    if (!problem) return res.status(404).json({ success: false, message: `Problem not found with ID ${req.params.id}` });
    if (typeof problem.populate === 'function') {
      try { await problem.populate('submittedBy', 'name email role profileDetails'); } catch (_) {}
    }

    // Auto-populate collegeSuggestions via Hugging Face model if not yet set
    if (!problem.collegeSuggestions || problem.collegeSuggestions.length === 0) {
      try {
        const colleges = await runCollegeMatchingPipeline(
          problem.aiAnalysis || { description: problem.description, category: problem.category },
          problem.location || { latitude: problem.latitude, longitude: problem.longitude, district: problem.district },
          5
        );
        if (Array.isArray(colleges) && colleges.length > 0) {
          problem.collegeSuggestions = colleges;
          if (typeof problem.save === 'function') {
            await problem.save();
          }
        }
      } catch (err) {
        console.warn('[Hugging Face Matcher Notice]: Could not auto-populate colleges:', err.message);
      }
    }

    return res.status(200).json({ success: true, data: problem });
  } catch (err) {
    next(err);
  }
};

// @desc    Update Problem Statement (owner only)
// @route   PUT /api/problems/:id
// @access  Private
const updateProblemStatement = async (req, res, next) => {
  try {
    let problem = await ProblemStatement.findById(req.params.id);
    if (!problem) return res.status(404).json({ success: false, message: 'Problem statement not found.' });
    if (problem.submittedBy.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: 'Not authorized to update this problem statement.' });

    if (req.body.location) req.body.location.coordinates = resolveCoordinates(req.body.location);
    if (req.body.description && req.body.description !== problem.description)
      req.body.aiAnalysis = await analyzeProblemWithGroq(req.body.description);

    problem = await ProblemStatement.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true }).populate('submittedBy', 'name email role');

    if (problem.followers && problem.followers.length > 0) {
      (async () => {
        try {
          const notifs = problem.followers
            .filter((fId) => fId.toString() !== req.user._id.toString())
            .map((followerId) => ({
              recipient: followerId,
              type: 'FOLLOWED_UPDATE',
              title: 'Update on Followed Issue',
              message: `The issue "${problem.title}" was updated. Status: ${problem.status}.`,
              problemId: problem._id,
              metadata: { status: problem.status }
            }));
          if (notifs.length > 0) {
            await Notification.insertMany(notifs);

            const followerRecipientIds = notifs.map((n) => n.recipient);
            pushNotificationService.sendPushToUsers(followerRecipientIds, {
              title: 'Update on Followed Issue',
              body: `"${problem.title}" status updated: ${problem.status}.`,
              data: {
                problemId: problem._id.toString(),
                type: 'FOLLOWED_UPDATE'
              }
            }).catch((e) => console.error('[Push Dispatch Follower Error]:', e.message));
          }
        } catch (e) {
          console.error('[Update Follower Notification Error]:', e.message);
        }
      })();
    }

    return res.status(200).json({ success: true, message: 'Problem statement updated.', data: problem });
  } catch (err) {
    next(err);
  }
};

// @desc    Delete Problem Statement (owner only)
// @route   DELETE /api/problems/:id
// @access  Private
const deleteProblemStatement = async (req, res, next) => {
  try {
    const problem = await ProblemStatement.findById(req.params.id);
    if (!problem) return res.status(404).json({ success: false, message: 'Problem statement not found.' });
    if (problem.submittedBy.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: 'Not authorized to delete this problem statement.' });
    await ProblemStatement.findByIdAndDelete(req.params.id);
    return res.status(200).json({ success: true, message: 'Problem statement deleted successfully.' });
  } catch (err) {
    next(err);
  }
};

// @desc    Toggle Upvote on a Problem Statement
// @route   POST /api/problems/:id/upvote
// @access  Private
const toggleUpvote = async (req, res, next) => {
  try {
    const problem = await ProblemStatement.findById(req.params.id);
    if (!problem) return res.status(404).json({ success: false, message: 'Problem statement not found.' });

    const userId = req.user._id;
    const hasUpvoted = problem.upvotedBy.includes(userId);

    if (hasUpvoted) {
      problem.upvotedBy.pull(userId);
      problem.upvotesCount -= 1;
    } else {
      problem.upvotedBy.push(userId);
      problem.upvotesCount += 1;
    }

    await problem.save();

    return res.status(200).json({
      success: true,
      message: hasUpvoted ? 'Upvote removed' : 'Upvote added',
      data: {
        upvotesCount: problem.upvotesCount,
        hasUpvoted: !hasUpvoted
      }
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Add a comment to a Problem Statement
// @route   POST /api/problems/:id/comments
// @access  Private
const addComment = async (req, res, next) => {
  try {
    const problem = await ProblemStatement.findById(req.params.id);
    if (!problem) return res.status(404).json({ success: false, message: 'Problem statement not found.' });

    const { text, images } = req.body;
    if (!text || text.trim() === '') {
      return res.status(400).json({ success: false, message: 'Comment text is required' });
    }

    const comment = await Comment.create({
      problemId: problem._id,
      author: req.user._id,
      text,
      images: images || []
    });

    problem.commentsCount += 1;
    await problem.save();

    await comment.populate('author', 'name email role profileDetails avatar');

    return res.status(201).json({ success: true, data: comment });
  } catch (err) {
    next(err);
  }
};

// @desc    Get comments for a Problem Statement
// @route   GET /api/problems/:id/comments
// @access  Private
const getComments = async (req, res, next) => {
  try {
    const comments = await Comment.find({ problemId: req.params.id })
      .populate('author', 'name email role profileDetails avatar')
      .populate('replies.author', 'name email role profileDetails avatar')
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, data: comments });
  } catch (err) {
    next(err);
  }
};

// @desc    Get top matched companies/industries for a Problem Statement
// @route   GET /api/problems/:id/matched-companies
// @access  Private
const getMatchedCompaniesForProblem = async (req, res, next) => {
  try {
    const problem = await ProblemStatement.findById(req.params.id);
    if (!problem) {
      return res.status(404).json({ success: false, message: 'Problem statement not found' });
    }

    // If companySuggestions already exist on problem document, return cached suggestions
    if (problem.companySuggestions && problem.companySuggestions.length > 0 && !req.query.refresh) {
      return res.status(200).json({ success: true, source: 'cached', data: problem.companySuggestions });
    }

    // Fetch registered companies from MongoDB database
    const dbCompanies = await Company.find({}).lean();

    // Invoke Python Company Matcher via Gradio client service
    const matchedCompanies = await runCompanyMatchingPipeline(
      problem.aiAnalysis || { description: problem.description },
      problem.location,
      dbCompanies,
      Number(req.query.top_k || 5)
    );

    // Save updated suggestions back to MongoDB document
    problem.companySuggestions = matchedCompanies;
    await problem.save();

    return res.status(200).json({ success: true, source: 'live_ai', data: matchedCompanies });
  } catch (err) {
    next(err);
  }
};

// @desc    Match companies for arbitrary problem data (from Implementation Guide)
// @route   POST /api/problems/match-companies
// @access  Private
const matchCompaniesForProblem = async (req, res, next) => {
  try {
    const { problemData, location, topK = 5 } = req.body;

    if (!problemData) {
      return res.status(400).json({ success: false, message: 'problemData is required' });
    }

    // 1. Fetch registered companies from MongoDB database as candidates
    let candidateCompanies = [];
    try {
      if (Company) {
        candidateCompanies = await Company.find({ isVerified: true })
          .select('name domain expertise location isVerified')
          .lean();
      }
    } catch (dbErr) {
      console.warn('[DB Warning]: Could not fetch candidate companies from DB, relying on dataset CSV.', dbErr.message);
    }

    // 2. Invoke Hugging Face AI Model
    const matchedCompanies = await runCompanyMatchingPipeline(
      problemData,
      location || {},
      candidateCompanies,
      topK
    );

    return res.status(200).json({
      success: true,
      count: matchedCompanies.length,
      data: matchedCompanies
    });
  } catch (error) {
    console.error('[Match Companies API Error]:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to perform company matching',
      error: error.message
    });
  }
};

// @desc    Get or fetch matched colleges for a problem statement from Hugging Face model
// @route   GET /api/problems/:id/matched-colleges
// @access  Private
const getMatchedCollegesForProblem = async (req, res, next) => {
  try {
    const problem = await ProblemStatement.findById(req.params.id);
    if (!problem) {
      return res.status(404).json({ success: false, message: 'Problem statement not found' });
    }

    if (problem.collegeSuggestions && problem.collegeSuggestions.length > 0 && !req.query.refresh) {
      return res.status(200).json({ success: true, source: 'cached', data: problem.collegeSuggestions });
    }

    const matchedColleges = await runCollegeMatchingPipeline(
      problem.aiAnalysis || { description: problem.description, category: problem.category },
      problem.location || { latitude: problem.latitude, longitude: problem.longitude, district: problem.district },
      Number(req.query.top_k || 5)
    );

    problem.collegeSuggestions = matchedColleges;
    if (typeof problem.save === 'function') {
      await problem.save();
    }

    return res.status(200).json({ success: true, source: 'live_huggingface', data: matchedColleges });
  } catch (err) {
    console.error('[Get Matched Colleges Error]:', err.message);
    return res.status(err.message?.includes('ZeroGPU') ? 429 : 500).json({
      success: false,
      message: err.message,
      data: problem?.collegeSuggestions || []
    });
  }
};

// @desc    Match colleges for arbitrary problem data using Hugging Face model
// @route   POST /api/problems/match-colleges
// @access  Private
const matchCollegesForProblem = async (req, res, next) => {
  try {
    const { problemData, location, topK = 5 } = req.body;
    if (!problemData) {
      return res.status(400).json({ success: false, message: 'problemData is required' });
    }

    const matchedColleges = await runCollegeMatchingPipeline(
      problemData,
      location || {},
      topK
    );

    return res.status(200).json({
      success: true,
      count: matchedColleges.length,
      data: matchedColleges
    });
  } catch (error) {
    console.error('[Match Colleges API Error]:', error);
    return res.status(error.message?.includes('ZeroGPU') ? 429 : 500).json({
      success: false,
      message: error.message
    });
  }
};

// @desc    Reply to a Comment
// @route   POST /api/problems/comments/:commentId/reply
// @access  Private
const replyToComment = async (req, res, next) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found' });

    const { text } = req.body;
    if (!text || text.trim() === '') {
      return res.status(400).json({ success: false, message: 'Reply text is required' });
    }

    const reply = {
      author: req.user._id,
      text,
      likes: [],
      likesCount: 0
    };

    comment.replies.push(reply);
    await comment.save();

    const updatedComment = await Comment.findById(comment._id)
      .populate('author', 'name email role profileDetails avatar')
      .populate('replies.author', 'name email role profileDetails avatar');

    return res.status(201).json({ success: true, data: updatedComment });
  } catch (err) {
    next(err);
  }
};

// @desc    Toggle Like on Comment
// @route   POST /api/problems/comments/:commentId/like
// @access  Private
const toggleCommentLike = async (req, res, next) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found' });

    const userId = req.user._id.toString();
    const { replyId } = req.body;

    if (replyId) {
      const reply = comment.replies.id(replyId);
      if (!reply) return res.status(404).json({ success: false, message: 'Reply not found' });

      const index = reply.likes.findIndex((id) => id.toString() === userId);
      if (index === -1) {
        reply.likes.push(userId);
      } else {
        reply.likes.splice(index, 1);
      }
      reply.likesCount = reply.likes.length;
    } else {
      const index = comment.likes.findIndex((id) => id.toString() === userId);
      if (index === -1) {
        comment.likes.push(userId);
      } else {
        comment.likes.splice(index, 1);
      }
      comment.likesCount = comment.likes.length;
    }

    await comment.save();
    return res.status(200).json({ success: true, data: comment });
  } catch (err) {
    next(err);
  }
};

// @desc    Edit a Comment or Reply
// @route   PUT /api/problems/comments/:commentId
// @access  Private
const editComment = async (req, res, next) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found' });

    const { text, replyId } = req.body;
    if (!text || text.trim() === '') {
      return res.status(400).json({ success: false, message: 'Text is required' });
    }

    if (replyId) {
      const reply = comment.replies.id(replyId);
      if (!reply) return res.status(404).json({ success: false, message: 'Reply not found' });
      if (reply.author.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, message: 'Not authorized to edit this reply' });
      }
      reply.text = text;
      reply.updatedAt = Date.now();
    } else {
      if (comment.author.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, message: 'Not authorized to edit this comment' });
      }
      comment.text = text;
    }

    await comment.save();
    
    const updatedComment = await Comment.findById(comment._id)
      .populate('author', 'name email role profileDetails avatar')
      .populate('replies.author', 'name email role profileDetails avatar');

    return res.status(200).json({ success: true, data: updatedComment });
  } catch (err) {
    next(err);
  }
};

// @desc    Delete a Comment or Reply
// @route   DELETE /api/problems/comments/:commentId
// @access  Private
const deleteComment = async (req, res, next) => {
  try {
    const comment = await Comment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ success: false, message: 'Comment not found' });

    const { replyId } = req.body;

    if (replyId) {
      const reply = comment.replies.id(replyId);
      if (!reply) return res.status(404).json({ success: false, message: 'Reply not found' });
      if (reply.author.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, message: 'Not authorized to delete this reply' });
      }
      comment.replies.pull(replyId);
      await comment.save();
      
      const updatedComment = await Comment.findById(comment._id)
        .populate('author', 'name email role profileDetails avatar')
        .populate('replies.author', 'name email role profileDetails avatar');

      return res.status(200).json({ success: true, data: updatedComment });
    } else {
      if (comment.author.toString() !== req.user._id.toString()) {
        return res.status(403).json({ success: false, message: 'Not authorized to delete this comment' });
      }
      await comment.deleteOne();
      
      // Update problem's comment count
      const ProblemStatement = require('../models/ProblemStatement');
      await ProblemStatement.findByIdAndUpdate(comment.problemId, { $inc: { commentsCount: -1 } });
      
      return res.status(200).json({ success: true, message: 'Comment deleted successfully' });
    }
  } catch (err) {
    next(err);
  }
};

// @desc    Toggle Save/Bookmark Problem Statement
// @route   POST /api/problems/:id/save
// @access  Private
const toggleSaveProblem = async (req, res, next) => {
  try {
    const problem = await ProblemStatement.findById(req.params.id);
    if (!problem) return res.status(404).json({ success: false, message: 'Problem statement not found.' });

    const userId = req.user._id;
    if (!problem.savedBy) problem.savedBy = [];
    const isSaved = problem.savedBy.some((id) => id.toString() === userId.toString());

    if (isSaved) {
      problem.savedBy = problem.savedBy.filter((id) => id.toString() !== userId.toString());
    } else {
      problem.savedBy.push(userId);
    }

    await problem.save();

    return res.status(200).json({
      success: true,
      message: isSaved ? 'Removed from saved reports' : 'Saved to bookmarks',
      data: {
        isSaved: !isSaved,
        savedCount: problem.savedBy.length
      }
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Toggle Follow Updates on Problem Statement
// @route   POST /api/problems/:id/follow
// @access  Private
const toggleFollowProblem = async (req, res, next) => {
  try {
    const problem = await ProblemStatement.findById(req.params.id);
    if (!problem) return res.status(404).json({ success: false, message: 'Problem statement not found.' });

    const userId = req.user._id;
    if (!problem.followers) problem.followers = [];
    const isFollowing = problem.followers.some((id) => id.toString() === userId.toString());

    if (isFollowing) {
      problem.followers = problem.followers.filter((id) => id.toString() !== userId.toString());
    } else {
      problem.followers.push(userId);
    }

    await problem.save();

    if (!isFollowing) {
      const followTitle = 'Following Issue Updates 🔔';
      const followMessage = `You are now following "${problem.title}". You will receive notifications on status changes, university adoption, and progress.`;

      Notification.create({
        recipient: userId,
        type: 'FOLLOWED_UPDATE',
        title: followTitle,
        message: followMessage,
        problemId: problem._id,
        metadata: { status: problem.status }
      }).then((notif) => {
        pushNotificationService.sendPushToUser(userId, {
          title: followTitle,
          body: followMessage,
          data: {
            type: 'FOLLOWED_UPDATE',
            problemId: problem._id.toString(),
            notificationId: notif ? notif._id.toString() : ''
          }
        }).then((pushResult) => {
          console.log('[Follow Push Result]:', JSON.stringify(pushResult));
        }).catch((pushErr) => console.error('[Follow Push Error]:', pushErr.message));
      }).catch((err) => console.error('[Follow Notification Error]:', err.message));
    }

    return res.status(200).json({
      success: true,
      message: isFollowing ? 'Unfollowed issue updates' : 'Following issue updates',
      data: {
        isFollowing: !isFollowing,
        followersCount: problem.followers.length
      }
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Mark / Report Problem as Duplicate
// @route   POST /api/problems/:id/duplicate-report
// @access  Private
const reportDuplicate = async (req, res, next) => {
  try {
    const problem = await ProblemStatement.findById(req.params.id);
    if (!problem) return res.status(404).json({ success: false, message: 'Problem statement not found.' });

    const userId = req.user._id;
    const { notes, masterTicketId } = req.body;

    if (!problem.duplicateReports) problem.duplicateReports = [];
    const alreadyReported = problem.duplicateReports.some((r) => r.user && r.user.toString() === userId.toString());

    if (alreadyReported) {
      return res.status(400).json({
        success: false,
        message: 'You have already submitted a duplicate report for this issue.'
      });
    }

    problem.duplicateReports.push({
      user: userId,
      notes: notes || '',
      masterTicketId: masterTicketId || null,
      createdAt: new Date()
    });

    await problem.save();

    return res.status(200).json({
      success: true,
      message: 'Duplicate report submitted. Our team will verify and merge reports to boost priority.'
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Report Inappropriate / Spam / False Content
// @route   POST /api/problems/:id/report
// @access  Private
const reportProblemContent = async (req, res, next) => {
  try {
    const problem = await ProblemStatement.findById(req.params.id);
    if (!problem) return res.status(404).json({ success: false, message: 'Problem statement not found.' });

    const { reason, details } = req.body;
    if (!reason) {
      return res.status(400).json({ success: false, message: 'Report reason is required.' });
    }

    const userId = req.user._id;
    if (!problem.contentReports) problem.contentReports = [];

    const alreadyReported = problem.contentReports.some((r) => r.user && r.user.toString() === userId.toString());
    if (alreadyReported) {
      return res.status(400).json({
        success: false,
        message: 'You have already reported this issue. Our moderation team is reviewing it.'
      });
    }

    problem.contentReports.push({
      user: userId,
      reason,
      details: details || '',
      createdAt: new Date()
    });

    // Auto-flag for review if 3 or more reports received
    if (problem.contentReports.length >= 3) {
      problem.flaggedForReview = true;
    }

    await problem.save();

    return res.status(200).json({
      success: true,
      message: 'Report submitted successfully. Thank you for keeping HackCBS Portal safe and accurate.'
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createProblemStatement,
  getAllProblemStatements,
  getProblemStatementById,
  updateProblemStatement,
  deleteProblemStatement,
  toggleUpvote,
  toggleSaveProblem,
  toggleFollowProblem,
  reportDuplicate,
  reportProblemContent,
  addComment,
  getComments,
  getMatchedCompaniesForProblem,
  matchCompaniesForProblem,
  getMatchedCollegesForProblem,
  matchCollegesForProblem,
  replyToComment,
  toggleCommentLike,
  editComment,
  deleteComment
};
