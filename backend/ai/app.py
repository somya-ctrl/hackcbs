import os
import sys
import json
from typing import Optional, List, Dict, Any
import gradio as gr
import spaces

# Ensure local imports work
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import problem_analyzer
import embedder
import deduplicator
import college_matcher
import company_matcher

def _unwrap_payload(payload_input: Any) -> Dict[str, Any]:
    """Recursively unwraps stringified JSON, nested Gradio data lists, and payload formats."""
    curr = payload_input
    for _ in range(3):
        if isinstance(curr, str):
            curr = curr.strip()
            if (curr.startswith("{") and curr.endswith("}")) or (curr.startswith("[") and curr.endswith("]")):
                try:
                    curr = json.loads(curr)
                except Exception:
                    break
            else:
                break
        else:
            break

    if isinstance(curr, list) and len(curr) > 0:
        return _unwrap_payload(curr[0])

    if isinstance(curr, dict):
        if "data" in curr:
            if isinstance(curr["data"], list) and len(curr["data"]) > 0:
                return _unwrap_payload(curr["data"][0])
            elif isinstance(curr["data"], dict) and ("description" in curr["data"] or "problemDescription" in curr["data"] or "aiAnalysis" in curr["data"]):
                return curr["data"]
        return curr

    return {"description": str(curr)}

# ==========================================
# API 1: GROQ AI PROBLEM ANALYZER ONLY
# ==========================================
def run_problem_analysis(payload_str: str) -> str:
    """
    API 1: Takes problem description and returns Groq structured analysis.
    Input: {"description": "..."}
    """
    try:
        req_dict = _unwrap_payload(payload_str)
        description = (
            req_dict.get("description")
            or req_dict.get("problemDescription")
            or req_dict.get("problem")
            or req_dict.get("text")
            or req_dict.get("summary")
        )
        if not description:
            raise KeyError("Missing required field: 'description' (or 'problemDescription').")

        analysis = problem_analyzer.analyze_problem(description)
        return json.dumps({
            "success": True,
            "data": analysis
        })
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})

# ==========================================
# API 2: DEDUPLICATION CHECKER ONLY
# ==========================================
@spaces.GPU
def run_deduplication(payload_str: str) -> str:
    """
    API 2: Checks if a problem post is a duplicate against candidates using Multilingual-E5-Large & FAISS.
    """
    try:
        req_dict = _unwrap_payload(payload_str)
        
        # 1. Extract problem representation
        problem_data = (
            req_dict.get("problem")
            or req_dict.get("aiAnalysis")
            or req_dict.get("data", {}).get("aiAnalysis")
            or req_dict
        )
        location = req_dict.get("location") or problem_data.get("location") or {}
        self_tags = req_dict.get("selfTags") or problem_data.get("selfTags") or {}
        
        # 2. Extract or generate embedding for target problem
        embedding = req_dict.get("embedding") or problem_data.get("embedding")
        if not embedding:
            embedding = embedder.generate_problem_embedding(
                analysis_data=problem_data,
                self_tags=self_tags,
                location_data=location
            )
            
        # 3. Candidates comparison
        candidates = req_dict.get("candidates") or []
        max_dist = float(req_dict.get("maxDistanceKm") or 10.0)
        threshold = float(req_dict.get("similarityThreshold") or 0.88)
        
        dedup_result = deduplicator.find_duplicate_with_faiss(
            new_embedding=embedding,
            new_location=location,
            candidate_problems=candidates,
            max_distance_km=max_dist,
            similarity_threshold=threshold
        )
        
        return json.dumps({
            "success": True,
            "data": {
                "deduplication": dedup_result,
                "embedding": embedding
            }
        })
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})

# ==========================================
# API 3: COLLEGE MATCHER ONLY
# ==========================================
def run_college_matching(payload_str: str) -> str:
    """
    API 3: Matches colleges for a problem using Geo proximity + Domain + Semantic Expertise/Infra.
    Runs on CPU without ZeroGPU quota restrictions.
    """
    try:
        req_dict = _unwrap_payload(payload_str)
        top_k = req_dict.get("top_k") or req_dict.get("topKColleges") or 5
        location = req_dict.get("location")
        
        matches = college_matcher.match_colleges_for_problem(
            problem_input=req_dict,
            location_data=location,
            top_k=top_k
        )
        return json.dumps({"success": True, "data": matches})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})

# ==========================================
# API 4: COMPANY / INDUSTRY MATCHER ONLY
# ==========================================
@spaces.GPU
def run_company_matching(payload_str: str) -> str:
    """
    API 4: Matches companies/industries for a problem using Geo proximity + Domain + Multilingual-E5-Large Expertise.
    Input format:
    {
       "aiAnalysis": { ... exact Groq response format ... },
       "location": { "latitude": 23.3441, "longitude": 85.3096 },
       "candidates": [ { "id": "1", "name": "A K Industries", "domain": "livelihood", ... } ],
       "top_k": 5
    }
    """
    try:
        req_dict = _unwrap_payload(payload_str)
        top_k = req_dict.get("top_k") or req_dict.get("topKCompanies") or 5
        location = req_dict.get("location")
        candidates = req_dict.get("candidates") or req_dict.get("candidateCompanies") or []
        only_verified = bool(req_dict.get("onlyVerified") or req_dict.get("only_verified") or False)
        
        matches = company_matcher.match_companies_for_problem(
            problem_input=req_dict,
            location_data=location,
            candidate_companies=candidates,
            top_k=top_k,
            only_verified=only_verified
        )
        return json.dumps({"success": True, "data": matches})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})

# ==========================================
# API 5: FULL PIPELINE (Analyze + Dedup + College Match + Company Match)
# ==========================================
@spaces.GPU
def run_model_pipeline(payload_str: str) -> str:
    """
    API 5: End-to-end full pipeline.
    """
    try:
        req_dict = _unwrap_payload(payload_str)
        description = (
            req_dict.get("description")
            or req_dict.get("problemDescription")
            or req_dict.get("problem")
            or req_dict.get("text")
            or req_dict.get("summary")
        )
        if not description:
            raise KeyError("Missing required field: 'description'.")
        
        # 1. Groq Analysis
        ai_analysis = problem_analyzer.analyze_problem(description)
        
        # 2. Embedding
        embedding = embedder.generate_problem_embedding(
            analysis_data=ai_analysis,
            self_tags=req_dict.get("selfTags"),
            location_data=req_dict.get("location")
        )
        
        # 3. Deduplication
        dedup_result = deduplicator.find_duplicate_with_faiss(
            new_embedding=embedding,
            new_location=req_dict.get("location") or {},
            candidate_problems=req_dict.get("candidates") or [],
            max_distance_km=float(req_dict.get("maxDistanceKm") or 10.0),
            similarity_threshold=float(req_dict.get("similarityThreshold") or 0.88)
        )
        
        # 4. College Matching
        top_k_colleges = req_dict.get("topKColleges") or req_dict.get("top_k") or 5
        matched_colleges = college_matcher.match_colleges_for_problem(
            ai_analysis=ai_analysis,
            problem_input=req_dict,
            location_data=req_dict.get("location") or {},
            top_k=top_k_colleges
        )
        
        # 5. Company Matching
        top_k_companies = req_dict.get("topKCompanies") or req_dict.get("top_k") or 5
        candidate_companies = req_dict.get("candidateCompanies") or req_dict.get("companies") or []
        matched_companies = company_matcher.match_companies_for_problem(
            ai_analysis=ai_analysis,
            problem_input=req_dict,
            location_data=req_dict.get("location") or {},
            candidate_companies=candidate_companies,
            top_k=top_k_companies
        )
        
        return json.dumps({
            "success": True,
            "data": {
                "aiAnalysis": ai_analysis,
                "embedding": embedding,
                "deduplication": dedup_result,
                "matchedColleges": matched_colleges,
                "matchedCompanies": matched_companies
            }
        })
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})

# ==========================================
# GRADIO INTERFACE & APIS
# ==========================================
with gr.Blocks(title="HackCBS AI Services") as demo:
    gr.Markdown("# 🚀 HackCBS Modular AI Problem-Solving Platform")
    
    with gr.Tab("1. Problem Analyzer (Groq AI)"):
        p1_in = gr.Textbox(label="Problem Description JSON", lines=6, placeholder='{"description": "Severe water logging on road"}')
        p1_out = gr.Textbox(label="Groq Analysis Output", lines=8)
        p1_btn = gr.Button("Analyze Problem")
        p1_btn.click(fn=run_problem_analysis, inputs=p1_in, outputs=p1_out, api_name="analyze_problem")

    with gr.Tab("2. Deduplication Checker (E5 + FAISS)"):
        p2_in = gr.Textbox(label="Deduplication Request JSON (Problem + Candidates)", lines=10)
        p2_out = gr.Textbox(label="Deduplication Result", lines=8)
        p2_btn = gr.Button("Check Duplication")
        p2_btn.click(fn=run_deduplication, inputs=p2_in, outputs=p2_out, api_name="check_duplicate")

    with gr.Tab("3. College Matcher"):
        p3_in = gr.Textbox(label="Matching Request JSON", lines=10)
        p3_out = gr.Textbox(label="Matched Colleges", lines=8)
        p3_btn = gr.Button("Match Colleges")
        p3_btn.click(fn=run_college_matching, inputs=p3_in, outputs=p3_out, api_name="match_colleges")

    with gr.Tab("4. Company / Industry Matcher"):
        p4_in = gr.Textbox(label="Matching Request JSON", lines=10)
        p4_out = gr.Textbox(label="Matched Companies", lines=8)
        p4_btn = gr.Button("Match Companies")
        p4_btn.click(fn=run_company_matching, inputs=p4_in, outputs=p4_out, api_name="match_companies")

    with gr.Tab("5. Full Pipeline"):
        p5_in = gr.Textbox(label="Full Request JSON", lines=10)
        p5_out = gr.Textbox(label="Full Pipeline Response", lines=10)
        p5_btn = gr.Button("Run Full Pipeline")
        p5_btn.click(fn=run_model_pipeline, inputs=p5_in, outputs=p5_out, api_name="analyze")

if __name__ == "__main__":
    demo.launch()