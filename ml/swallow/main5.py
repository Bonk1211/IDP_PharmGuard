import cv2
import math
import numpy as np
import mediapipe as mp
import time

# ==========================================
# 1. INITIALIZE MEDIAPIPE (Face & Hands)
# ==========================================
mp_face_mesh = mp.solutions.face_mesh
face_mesh = mp_face_mesh.FaceMesh(max_num_faces=1, refine_landmarks=True, min_detection_confidence=0.5)

mp_hands = mp.solutions.hands
hands = mp_hands.Hands(max_num_hands=2, min_detection_confidence=0.5)
mp_drawing = mp.solutions.drawing_utils

# ==========================================
# 2. CALIBRATION & THRESHOLDS
# ==========================================
REQUIRED_CONFIDENCE = 0.85  
POSE_HOLD_TIME = 1.5        # Seconds to hold physical poses (Steps 1, 2, 3, 5)
INSPECTION_HOLD_TIME = 3.0  # Seconds to hold mouth open for scan (Step 4)

# HSV Colors 
PILL_HSV_LOWER = np.array([100, 150, 50])   
PILL_HSV_UPPER = np.array([140, 255, 255])
TONGUE_HSV_LOWER = np.array([160, 50, 50])  
TONGUE_HSV_UPPER = np.array([180, 255, 255])

# ==========================================
# 3. CORE MATH & VISION ENGINES
# ==========================================
# Generic 3D model points (standard anthropometric data)
MODEL_POINTS = np.array([
    (0.0, 0.0, 0.0),             # Nose tip (1)
    (0.0, -330.0, -65.0),        # Chin (152)
    (-225.0, 170.0, -135.0),     # Left eye corner (33)
    (225.0, 170.0, -135.0),      # Right eye corner (263)
    (-150.0, -150.0, -125.0),    # Left mouth corner (61)
    (150.0, -150.0, -125.0)      # Right mouth corner (291)
], dtype="double")

# Global for temporal smoothing
smoothed_conf = 0.0
ALPHA = 0.3 

def sigmoid(x, x0, k):
    return 1 / (1 + math.exp(-k * (x - x0)))

def get_head_pose(landmarks, w, h):
    # Select key 2D landmarks for PnP
    image_points = np.array([
        (landmarks[1].x * w, landmarks[1].y * h),   # Nose
        (landmarks[152].x * w, landmarks[152].y * h),# Chin
        (landmarks[33].x * w, landmarks[33].y * h),  # Left eye
        (landmarks[263].x * w, landmarks[263].y * h), # Right eye
        (landmarks[61].x * w, landmarks[61].y * h),  # Left mouth
        (landmarks[291].x * w, landmarks[291].y * h)  # Right mouth
    ], dtype="double")

    # Camera matrix (approximate)
    focal_length = w
    center = (w/2, h/2)
    camera_matrix = np.array([[focal_length, 0, center[0]],
                             [0, focal_length, center[1]],
                             [0, 0, 1]], dtype="double")
    
    dist_coeffs = np.zeros((4,1)) # Assuming no lens distortion
    (success, rotation_vector, translation_vector) = cv2.solvePnP(MODEL_POINTS, image_points, camera_matrix, dist_coeffs, flags=cv2.SOLVEPNP_ITERATIVE)
    
    # Get rotation matrix
    rmat, _ = cv2.Rodrigues(rotation_vector)
    # Extract Euler Angles (Pitch, Yaw, Roll)
    # decomposeProjectionMatrix returns (cameraMatrix, rotMatrix, transVect, rotMatrixX, rotMatrixY, rotMatrixZ, eulerAngles)
    res = cv2.decomposeProjectionMatrix(np.hstack((rmat, translation_vector)))
    angles = res[6] # eulerAngles is the 7th element
    pitch, yaw, roll = angles.flatten()
    
    # Normalizing pitch: In this projection, looking up (tilt) results in a positive pitch shift
    # We calibrate 'level' at ~0 and 'tilt' at > 20 degrees
    return pitch, yaw, roll

def get_distance(pt1, pt2, w, h):
    return math.hypot(int(pt2.x * w) - int(pt1.x * w), int(pt2.y * h) - int(pt1.y * h))

def calc_hand_to_mouth(landmarks, hand_landmarks_list, w, h):
    if not hand_landmarks_list: return 0.0
    upper_lip = landmarks[13]
    best = 0.0
    for hand in hand_landmarks_list:
        dist = get_distance(upper_lip, hand.landmark[8], w, h)
        # Using sigmoid for smoother hand-to-mouth confidence
        # dist is in pixels, 400px is roughly far, 100px is near
        norm_dist = max(0.0, 400.0 - dist)
        best = max(best, sigmoid(norm_dist, 250, 0.05))
    return best

def calc_tilt_precise(landmarks, w, h, frame=None):
    pitch, _, _ = get_head_pose(landmarks, w, h)
    # Sigmoid mapping: pitch of 25 degrees = 0.5 confidence, k=0.4 for steepness
    conf = sigmoid(pitch, 25, 0.4)
    if frame is not None:
        cv2.putText(frame, f"Pitch Angle: {pitch:.1f}deg", (w - 220, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 255), 1)
    return conf

def calc_level_precise(landmarks, w, h):
    pitch, _, _ = get_head_pose(landmarks, w, h)
    # Neutral is around 0-5 degrees. Sigmoid centered at 10 deg (returning to neutral)
    return sigmoid(-pitch, -10, 0.4)

def calc_mouth(landmarks, w, h):
    hz = get_distance(landmarks[61], landmarks[291], w, h)
    if hz == 0: return 0.0
    vt = get_distance(landmarks[13], landmarks[14], w, h)
    ratio = vt / hz
    # Sigmoid centered at 0.35 ratio
    return sigmoid(ratio, 0.35, 15)

def check_pill_debug(frame, landmarks, w, h):
    x_c = [int(landmarks[i].x * w) for i in [61, 291, 0, 17]]
    y_c = [int(landmarks[i].y * h) for i in [61, 291, 0, 17]]
    b = 15
    x_min, x_max = max(0, min(x_c)-b), min(w, max(x_c)+b)
    y_min, y_max = max(0, min(y_c)-b), min(h, max(y_c)+b)
    
    roi = frame[y_min:y_max, x_min:x_max]
    if roi.size == 0: return False, None
    mask = cv2.inRange(cv2.cvtColor(roi, cv2.COLOR_BGR2HSV), PILL_HSV_LOWER, PILL_HSV_UPPER)
    return cv2.countNonZero(mask) > 15, mask

def check_tongue_lift(frame, landmarks, w, h):
    y_mid = (int(landmarks[13].y * h) + int(landmarks[14].y * h)) // 2
    x_c = [int(landmarks[i].x * w) for i in [61, 291, 0, 17]]
    y_c = [int(landmarks[i].y * h) for i in [61, 291, 0, 17]]
    b = 15
    x_min, x_max = max(0, min(x_c)-b), min(w, max(x_c)+b)
    y_min, y_max = max(0, min(y_c)-b), min(h, max(y_c)+b)
    
    roi = frame[y_min:y_max, x_min:x_max]
    if roi.size == 0: return False, None
    mask = cv2.inRange(cv2.cvtColor(roi, cv2.COLOR_BGR2HSV), TONGUE_HSV_LOWER, TONGUE_HSV_UPPER)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3,3), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    if contours:
        c = max(contours, key=cv2.contourArea)
        M = cv2.moments(c)
        if M["m00"] > 0:
            cX = int(M["m10"] / M["m00"]) + x_min
            cY = int(M["m01"] / M["m00"]) + y_min
            cv2.circle(frame, (cX, cY), 5, (255, 0, 255), -1)
            cv2.line(frame, (x_min, y_mid), (x_max, y_mid), (0, 255, 255), 1) 
            return cY < y_mid, mask
    return False, mask

# ==========================================
# 4. MASTER STATE MACHINE LOOP
# ==========================================
cap = cv2.VideoCapture(0)
system_state = "STEP_1_HAND" 
timer_start = 0  

print("Starting Buffered 5-Step Verification...")

while cap.isOpened():
    success, frame = cap.read()
    if not success: break

    frame = cv2.flip(frame, 1)
    h, w, _ = frame.shape
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    
    face_results = face_mesh.process(rgb_frame)
    hand_results = hands.process(rgb_frame)

    if hand_results.multi_hand_landmarks:
        for hand_landmarks in hand_results.multi_hand_landmarks:
            mp_drawing.draw_landmarks(frame, hand_landmarks, mp_hands.HAND_CONNECTIONS)

    # UI Header Background
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (w, 160), (0, 0, 0), -1)
    frame = cv2.addWeighted(overlay, 0.6, frame, 0.4, 0) 
    
    conf = 0.0
    text = ""
    target_time = POSE_HOLD_TIME 
    pose_held_successfully = False

    if face_results.multi_face_landmarks:
        lms = face_results.multi_face_landmarks[0].landmark

        # --- GATHER CONFIDENCE BASED ON CURRENT STATE ---
        raw_conf = 0.0
        if system_state == "STEP_1_HAND":
            text = "STEP 1: Bring pill/cup to mouth"
            raw_conf = calc_hand_to_mouth(lms, hand_results.multi_hand_landmarks, w, h)
            
        elif system_state == "STEP_2_TILT":
            text = "STEP 2: Tilt head back to swallow"
            raw_conf = calc_tilt_precise(lms, w, h, frame)
            
        elif system_state == "STEP_3_LEVEL":
            text = "STEP 3: Return head to level position"
            raw_conf = calc_level_precise(lms, w, h)
            
        elif system_state == "STEP_4_MOUTH":
            text = "STEP 4: Open mouth wide"
            target_time = INSPECTION_HOLD_TIME # Override timer for this step
            raw_conf = calc_mouth(lms, w, h)
            
        elif system_state == "STEP_5_TONGUE":
            text = "STEP 5: Lift tongue to roof of mouth"
            raw_conf = calc_mouth(lms, w, h) # Keep mouth open to track confidence
            if raw_conf >= REQUIRED_CONFIDENCE:
                # Override raw_conf based on tongue lift status
                is_lifted, mask = check_tongue_lift(frame, lms, w, h)
                
                if mask is not None:
                    frame[20:120, w-120:w-20] = cv2.resize(cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR), (100, 100))
                    cv2.putText(frame, "Tongue Vision", (w-120, 140), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 0, 255), 1)
                    
                if not is_lifted: 
                    raw_conf = 0.0 # Force timer reset if tongue drops

        # --- TEMPORAL SMOOTHING ---
        smoothed_conf = (1 - ALPHA) * smoothed_conf + ALPHA * raw_conf
        conf = smoothed_conf # Use smoothed value for UI and logic

        # --- UNIVERSAL TIMER LOGIC ---
        if conf >= REQUIRED_CONFIDENCE:
            if timer_start == 0: 
                timer_start = time.time()
                
            elapsed = time.time() - timer_start
            countdown = max(0.0, target_time - elapsed)
            
            # Special Pill Inspection Logic during Step 4
            if system_state == "STEP_4_MOUTH":
                pill_found, mask = check_pill_debug(frame, lms, w, h)
                if mask is not None:
                    frame[20:120, w-120:w-20] = cv2.resize(cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR), (100, 100))
                    cv2.putText(frame, "Pill Vision", (w-115, 140), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)

                if pill_found:
                    cv2.putText(frame, "WARNING: Pill Detected!", (w//2-100, 140), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
                    timer_start = time.time() # Reset timer immediately if pill seen
                else:
                    cv2.putText(frame, f"Inspecting... {countdown:.1f}s", (w//2-60, 140), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
            else:
                # Normal pose hold text
                cv2.putText(frame, f"Holding... {countdown:.1f}s", (w//2-60, 140), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)

            # Check if timer finished
            if elapsed >= target_time:
                pose_held_successfully = True
                timer_start = 0 # Reset for the next step
        else:
            timer_start = 0 # Reset if they break the pose

        # --- STATE TRANSITION ENGINE ---
        if pose_held_successfully:
            if system_state == "STEP_1_HAND": system_state = "STEP_2_TILT"
            elif system_state == "STEP_2_TILT": system_state = "STEP_3_LEVEL"
            elif system_state == "STEP_3_LEVEL": system_state = "STEP_4_MOUTH"
            elif system_state == "STEP_4_MOUTH": system_state = "STEP_5_TONGUE"
            elif system_state == "STEP_5_TONGUE": system_state = "SUCCESS"


    # -----------------------------------------------------
    # UI RENDERING
    # -----------------------------------------------------
    if system_state != "SUCCESS":
        cv2.putText(frame, text, (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        
        c_color = (0, 255, 0) if conf >= REQUIRED_CONFIDENCE else (0, 255, 255) if conf > 0.5 else (0, 0, 255)
        cv2.putText(frame, f"Confidence: {conf:.2f} / {REQUIRED_CONFIDENCE}", (20, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.7, c_color, 2)
        
        cv2.rectangle(frame, (20, 100), (20 + int(conf * 400), 115), c_color, -1)
        cv2.rectangle(frame, (20, 100), (420, 115), (255, 255, 255), 2)
    else:
        cv2.putText(frame, "VERIFICATION COMPLETE", (w//2 - 180, h//2), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 255, 0), 3)
        cv2.putText(frame, "Sequence Passed", (w//2 - 100, h//2 + 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)

    cv2.imshow('Buffered Verification', frame)
    if cv2.waitKey(5) & 0xFF == 27: break

cap.release()
cv2.destroyAllWindows()
