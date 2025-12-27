import math
import numpy as np
from datetime import datetime, timedelta
from sgp4.api import Satrec, jday
import traceback


def eci2lla(r_eci, utc_vec, jd=None, fr=None):
    """
    ECI坐标转换为大地坐标（经纬高）
    r_eci: ECI坐标 (米)
    utc_vec: UTC时间向量 [年, 月, 日, 时, 分, 秒]
    jd, fr: 儒略日（可选，用于TEME到ECI转换）
    返回: [纬度(度), 经度(度), 高度(米)]
    """
    # WGS84椭球参数
    a = 6378137.0  # 长半轴, m
    f = 1.0 / 298.257223563  # 扁率
    e2 = 2 * f - f * f  # 第一偏心率平方

    # r_eci已经是米，不需要转换
    if isinstance(r_eci, np.ndarray):
        x, y, z = r_eci  # 已经是米
    else:
        x, y, z = r_eci

    # 将TEME转换为ECI
    if jd is not None and fr is not None:
        utc = jd + fr - 0.5
        t = (utc - 2451545.0) / 36525.0

        # 计算GMST（格林尼治恒星时）
        gmst = 280.46061837 + 360.98564736629 * (utc - 2451545.0) + \
               0.000387933 * t * t - t * t * t / 38710000.0
        gmst_rad = math.radians(gmst % 360.0)

        # TEME坐标系相对于ECI绕Z轴旋转了GMST角度
        cos_gmst = math.cos(gmst_rad)
        sin_gmst = math.sin(gmst_rad)

        # 反向旋转矩阵
        x_eci = x * cos_gmst + y * sin_gmst
        y_eci = -x * sin_gmst + y * cos_gmst
        z_eci = z

        x, y, z = x_eci, y_eci, z_eci

    # 计算经度
    lon = math.atan2(y, x)

    # 计算地心距 (转换为千米用于计算)
    p = math.sqrt(x*x + y*y) / 1000.0  # 转换为km
    z_km = z / 1000.0  # 转换为km

    # 初始估计大地纬度
    lat = math.atan2(z_km, p * (1 - e2))

    # 迭代计算大地纬度
    for _ in range(10):
        sin_lat = math.sin(lat)
        N = a / math.sqrt(1 - e2 * sin_lat * sin_lat) / 1000.0  # 转换为km
        h = p / math.cos(lat) - N

        if h < -1000:
            h = 0

        lat_new = math.atan2(z_km, p * (1 - e2 * N / (N + h)))

        if abs(lat_new - lat) < 1e-12:
            break
        lat = lat_new

    # 计算最终的高度
    sin_lat = math.sin(lat)
    N = a / math.sqrt(1 - e2 * sin_lat * sin_lat) / 1000.0  # 转换为km
    h = p / math.cos(lat) - N

    # 确保高度不为负
    if h < 0:
        h = 0

    # 转换为度
    lat_deg = math.degrees(lat)
    lon_deg = math.degrees(lon)

    # 高度转换为米返回
    return [lat_deg, lon_deg, h * 1000]


def eul2quat(eul):
    """欧拉角转四元数 (Z-Y-X顺序)"""
    roll, pitch, yaw = eul

    cy = math.cos(yaw * 0.5)
    sy = math.sin(yaw * 0.5)
    cp = math.cos(pitch * 0.5)
    sp = math.sin(pitch * 0.5)
    cr = math.cos(roll * 0.5)
    sr = math.sin(roll * 0.5)

    w = cr * cp * cy + sr * sp * sy
    x = sr * cp * cy - cr * sp * sy
    y = cr * sp * cy + sr * cp * sy
    z = cr * cp * sy - sr * sp * cy

    return [w, x, y, z]


def quat2rotm(q):
    """四元数转旋转矩阵"""
    w, x, y, z = q

    R = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]
    ])

    return R


def footprintCenter_zitai(rsat, vsat, side, utc):
    """
    星载SAR波束中心与WGS84椭球交点（大地坐标）
    rsat: 卫星位置 (km)
    vsat: 卫星速度 (km/s)
    side: 侧摆角度 (度)
    utc: UTC时间
    返回: (lat, lon, height)
    """
    # 基本常数
    a = 6378.137  # WGS84 长半轴 km
    c = 6356.752314245  # WGS84 短半轴 km

    # 构造 RTN→ECI 旋转矩阵
    rHat = -rsat / np.linalg.norm(rsat)  # R 指向地心
    hVec = np.cross(rHat, vsat)  # Y
    nHat = hVec / np.linalg.norm(hVec)  # N 轨道面法线
    tHat = np.cross(nHat, rHat)  # T 沿速度
    R_OT = np.column_stack([tHat, nHat, rHat])  # RTN→ECI

    # 本体→RTN 旋转矩阵：侧摆是围绕T轴旋转
    # 原来错误的欧拉角：[0, 0, math.radians(side)] - 这是绕Z轴旋转
    # 正确的欧拉角：绕T轴（X轴）旋转侧摆角
    # 欧拉角顺序为 [roll绕X, pitch绕Y, yaw绕Z]
    # 对于侧摆，我们只需要绕T轴（X轴）旋转
    side_rad = math.radians(side)
    
    # 绕X轴（T轴）旋转侧摆角的旋转矩阵
    # 注意：这是从本体到RTN的旋转，侧摆角会使波束在N-R平面内旋转
    cos_side = math.cos(side_rad)
    sin_side = math.sin(side_rad)
    
    R_BO = np.array([
        [1, 0, 0],           # T轴不变
        [0, cos_side, -sin_side],  # N轴分量
        [0, sin_side, cos_side]    # R轴分量
    ])
    
    # 在本体系内波束指向：假设本体坐标系中天线指向-Z方向（朝向地球）
    # 或者如果是星下点，可以指向 [0, 0, -1]
    lBody = np.array([0, 0, -1])  # 指向地球
    
    # 将波束指向从本体转换到RTN
    lRTN = np.dot(R_BO, lBody)
    
    # 将RTN转换到ECI
    lEci = np.dot(R_OT, lRTN)

    # 射线与 WGS84 椭球求交（Newton 迭代）
    t = 0  # 初值
    for iter in range(20):
        r = rsat + t * lEci
        f = (r[0] ** 2 + r[1] ** 2) / a ** 2 + r[2] ** 2 / c ** 2 - 1
        if abs(f) < 1e-12:
            break
        dfdt = 2 * (r[0] * lEci[0] + r[1] * lEci[1]) / a ** 2 + 2 * r[2] * lEci[2] / c ** 2
        t = t - f / dfdt

    rEci = (rsat + t * lEci) * 1000  # m，交点

    # ECI→大地坐标
    utc_vec = [utc.year, utc.month, utc.day, utc.hour, utc.minute, utc.second]

    # 计算儒略日（用于TEME到ECI转换）
    jd, fr = jday(utc.year, utc.month, utc.day, utc.hour, utc.minute, utc.second)

    # 使用eci2lla函数，传递儒略日信息
    lla = eci2lla(rEci, utc_vec, jd, fr)

    return lla[0], lla[1], lla[2]  # lat, lon, h


def calculate_satellite_position_with_sgp4(tle_line1, tle_line2, time_utc):
    """
    使用SGP4算法计算卫星在指定时间的位置和速度
    返回: position_km, velocity_kms (均为TEME坐标系), jd, fr
    """
    try:
        # 解析TLE创建卫星对象
        satellite = Satrec.twoline2rv(tle_line1, tle_line2)

        # 将UTC时间转换为儒略日
        year, month, day = time_utc.year, time_utc.month, time_utc.day
        hour, minute, second = time_utc.hour, time_utc.minute, time_utc.second

        jd, fr = jday(year, month, day, hour, minute, second)

        # 计算位置和速度 (km 和 km/s) - 这是TEME坐标系
        e, r, v = satellite.sgp4(jd, fr)

        if e != 0:
            print(f"SGP4错误代码: {e}")
            # 返回默认值
            return np.array([7000, 0, 0]), np.array([7, 0, 0]), jd, fr

        # r和v已经是km和km/s
        position_km = np.array(r)
        velocity_kms = np.array(v)

        return position_km, velocity_kms, jd, fr

    except Exception as e:
        print(f"SGP4计算卫星位置时出错: {e}")
        traceback.print_exc()
        return np.array([6878, 0, 0]), np.array([7.6, 0, 0]), 0, 0


def calculate_realistic_orbit_with_footprint(satellites, side_angle=20):
    """
    使用SGP4算法和footprint函数计算卫星位置和条带边界
    satellites: 包含TLE数据的卫星列表
    side_angle: 侧摆角度
    返回: 包含卫星位置、条带边界的数据列表
    """
    print(f"=== 使用SGP4算法和footprint函数计算卫星位置和条带边界 (侧摆角: {side_angle}°) ===")

    satellite_data = []

    for i, sat in enumerate(satellites):
        positions = []  # 卫星位置 (lon, lat, height)
        left_swath = []  # 左侧条带边界
        right_swath = []  # 右侧条带边界

        # 生成24小时的轨道数据，每5分钟一个点
        num_points = 288  # 24小时 * 12点/小时
        time_step = 300  # 5分钟 = 300秒

        for j in range(num_points):
            # 计算当前时间
            time_offset = j * time_step
            current_time = datetime.utcnow() + timedelta(seconds=time_offset)

            try:
                # 使用SGP4计算卫星在TEME坐标系中的位置和速度
                position_km, velocity_kms, jd, fr = calculate_satellite_position_with_sgp4(
                    sat['line1'], sat['line2'], current_time
                )

                # 将TEME位置转换为经纬高用于显示卫星轨迹
                lat, lon, height = eci2lla(
                    position_km * 1000,  # 转换为米
                    [current_time.year, current_time.month, current_time.day,
                     current_time.hour, current_time.minute, current_time.second],
                    jd, fr  # 传递儒略日信息
                )

                positions.extend([lon, lat, height])

                # 使用footprint函数计算左右条带边界
                # 左侧条带 (负侧摆角)
                try:
                    lat_left, lon_left, h_left = footprintCenter_zitai(
                        position_km,
                        velocity_kms,
                        -side_angle,  # 左侧使用负角度
                        current_time
                    )
                    left_swath.extend([lon_left, lat_left, 0])  # 高度设为0
                except Exception as e1:
                    print(f"计算左侧条带边界时出错: {e1}")
                    left_swath.extend([lon - 1, lat, 0])

                # 右侧条带 (正侧摆角)
                try:
                    lat_right, lon_right, h_right = footprintCenter_zitai(
                        position_km,
                        velocity_kms,
                        side_angle,  # 右侧使用正角度
                        current_time
                    )
                    right_swath.extend([lon_right, lat_right, 0])  # 高度设为0
                except Exception as e2:
                    print(f"计算右侧条带边界时出错: {e2}")
                    right_swath.extend([lon + 1, lat, 0])

            except Exception as e:
                print(f"处理时间点 {j} 时出错: {e}")
                # 添加默认位置
                positions.extend([0, 0, 500000])
                left_swath.extend([-1, 0, 0])
                right_swath.extend([1, 0, 0])

        satellite_data.append({
            'name': sat['name'],
            'positions': positions,
            'leftSwath': left_swath,
            'rightSwath': right_swath,
            'initialPosition': positions[0:3] if positions else [0, 0, 500000]
        })
        print(f"为卫星 {sat['name']} 生成了轨道和条带边界")

    return satellite_data